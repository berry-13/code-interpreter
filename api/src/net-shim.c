/* net-shim — makes an ordinary TCP client inside the jail talk to the per-job
 * egress proxy over a Unix socket, without the process ever creating an
 * AF_INET socket.
 *
 * Loaded via LD_PRELOAD (only for jobs with sandbox networking enabled) so
 * that HTTP_PROXY-aware tooling — requests, urllib, pip, curl, wget — works
 * unmodified: they "connect to 127.0.0.1:8080", and this shim quietly turns
 * that into a connect() on the bind-mounted /tmp/net.sock.
 *
 * WHY THIS EXISTS INSTEAD OF A LOOPBACK LISTENER
 * ----------------------------------------------
 * The obvious design is a relay listening on 127.0.0.1 inside the jail, which
 * needs the seccomp policy to permit AF_INET. That was tried and is NOT safe
 * on the KVM/libkrun runner: libkrun's TSI intercepts AF_INET at the guest
 * socket layer and forwards it to the host over vsock, so the connection never
 * meets the jail's empty network namespace. Measured on a live deployment,
 * sandboxed code with AF_INET permitted got a real UDP DNS answer from
 * 1.1.1.1 and opened raw TCP to public hosts — straight past the proxy.
 *
 * So the seccomp block on AF_INET/AF_INET6 stays exactly as it always was, and
 * this shim removes the *need* for it to be relaxed. The security properties
 * that follow are worth stating plainly:
 *
 *   - This shim is a CONVENIENCE, never a boundary. It runs inside the
 *     sandbox, as the user's own code, and can be disabled by that code.
 *   - Disabling it FAILS CLOSED. Clear LD_PRELOAD, call socket() by raw
 *     syscall, or link statically, and the AF_INET socket() hits the unchanged
 *     seccomp rule and returns EPERM. Bypassing the shim buys nothing but a
 *     broken network stack.
 *   - It grants no reachability of its own: it can only connect to the one
 *     Unix socket path, and the proxy on the other end applies every policy
 *     gate. Redirecting anything else is refused here too.
 */

#define _GNU_SOURCE
#include <arpa/inet.h>
#include <dlfcn.h>
#include <errno.h>
#include <netinet/in.h>
#include <signal.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

#define DEFAULT_SOCKET "/tmp/net.sock"
#define DEFAULT_PORT 8080
/* Comfortably above the sandbox's RLIMIT_NOFILE (2048 by default). A socket
 * landing on a higher fd simply is not tracked, and its connect() fails —
 * closed, not open. */
#define MAX_TRACKED_FD 8192

static int (*real_socket)(int, int, int);
static int (*real_connect)(int, const struct sockaddr *, socklen_t);
static int (*real_close)(int);
static int (*real_setsockopt)(int, int, int, const void *, socklen_t);
static int (*real_getpeername)(int, struct sockaddr *, socklen_t *);
static int (*real_getsockname)(int, struct sockaddr *, socklen_t *);

static volatile sig_atomic_t redirected[MAX_TRACKED_FD];
static char socket_path[108];
static size_t socket_path_len;
static uint16_t proxy_port;
static int initialized;

__attribute__((constructor)) static void net_shim_init(void) {
    if (initialized) return;

    real_socket = dlsym(RTLD_NEXT, "socket");
    real_connect = dlsym(RTLD_NEXT, "connect");
    real_close = dlsym(RTLD_NEXT, "close");
    real_setsockopt = dlsym(RTLD_NEXT, "setsockopt");
    real_getpeername = dlsym(RTLD_NEXT, "getpeername");
    real_getsockname = dlsym(RTLD_NEXT, "getsockname");

    const char *path = getenv("NET_SHIM_SOCKET");
    if (path == NULL || *path == '\0' || strlen(path) >= sizeof(((struct sockaddr_un *)0)->sun_path)) {
        path = DEFAULT_SOCKET;
    }
    socket_path_len = strlen(path);
    memcpy(socket_path, path, socket_path_len);
    socket_path[socket_path_len] = '\0';

    const char *port = getenv("NET_SHIM_PORT");
    long parsed = (port != NULL && *port != '\0') ? strtol(port, NULL, 10) : DEFAULT_PORT;
    proxy_port = (parsed > 0 && parsed < 65536) ? (uint16_t)parsed : DEFAULT_PORT;

    initialized = 1;
}

static int is_tracked(int fd) {
    return fd >= 0 && fd < MAX_TRACKED_FD && redirected[fd];
}

/* True only for the single endpoint the proxy is published on. Everything
 * else — another loopback port, any other address — is refused rather than
 * redirected, so this cannot be used as a generic connect() primitive. */
static int is_proxy_endpoint(const struct sockaddr *addr, socklen_t len) {
    if (addr == NULL) return 0;
    if (addr->sa_family == AF_INET && len >= (socklen_t)sizeof(struct sockaddr_in)) {
        const struct sockaddr_in *in = (const struct sockaddr_in *)(const void *)addr;
        return in->sin_addr.s_addr == htonl(INADDR_LOOPBACK) &&
               ntohs(in->sin_port) == proxy_port;
    }
    if (addr->sa_family == AF_INET6 && len >= (socklen_t)sizeof(struct sockaddr_in6)) {
        const struct sockaddr_in6 *in6 = (const struct sockaddr_in6 *)(const void *)addr;
        if (ntohs(in6->sin6_port) != proxy_port) return 0;
        if (IN6_IS_ADDR_LOOPBACK(&in6->sin6_addr)) return 1;
        /* A dual-stack client reaching 127.0.0.1 sends it as ::ffff:127.0.0.1
         * on an AF_INET6 socket — which is what the JVM does, so a Java job
         * pointed at the proxy was refused here and reported "Connection
         * refused" no matter how the proxy was configured. Same endpoint, same
         * single allowed port; only the spelling differs. */
        if (IN6_IS_ADDR_V4MAPPED(&in6->sin6_addr)) {
            uint32_t v4;
            memcpy(&v4, &in6->sin6_addr.s6_addr[12], sizeof(v4));
            return v4 == htonl(INADDR_LOOPBACK);
        }
        return 0;
    }
    return 0;
}

int socket(int domain, int type, int protocol) {
    net_shim_init();
    if (real_socket == NULL) {
        errno = ENOSYS;
        return -1;
    }

    /* Only stream sockets are impersonated. Datagram AF_INET (a DNS query, for
     * instance) is passed straight through to the kernel, where the unchanged
     * seccomp policy refuses it — the sandbox has no resolver and needs none,
     * because the proxy resolves on its behalf. */
    int base_type = type & 0x0f;
    if ((domain == AF_INET || domain == AF_INET6) && base_type == SOCK_STREAM) {
        int flags = type & (SOCK_CLOEXEC | SOCK_NONBLOCK);
        int fd = real_socket(AF_UNIX, SOCK_STREAM | flags, 0);
        if (fd >= 0 && fd < MAX_TRACKED_FD) redirected[fd] = 1;
        return fd;
    }

    return real_socket(domain, type, protocol);
}

int connect(int fd, const struct sockaddr *addr, socklen_t len) {
    net_shim_init();
    if (real_connect == NULL) {
        errno = ENOSYS;
        return -1;
    }

    if (!is_tracked(fd)) {
        return real_connect(fd, addr, len);
    }

    if (!is_proxy_endpoint(addr, len)) {
        /* A tracked socket aimed anywhere but the proxy. Report the same thing
         * an empty network namespace would: nothing is listening. */
        errno = ECONNREFUSED;
        return -1;
    }

    struct sockaddr_un un;
    memset(&un, 0, sizeof(un));
    un.sun_family = AF_UNIX;
    /* Length was bounded at init against sizeof(un.sun_path), so this always
     * leaves the trailing NUL that memset put there. */
    memcpy(un.sun_path, socket_path, socket_path_len);
    return real_connect(fd, (const struct sockaddr *)(const void *)&un, sizeof(un));
}

int close(int fd) {
    if (fd >= 0 && fd < MAX_TRACKED_FD) redirected[fd] = 0;
    net_shim_init();
    if (real_close == NULL) {
        errno = ENOSYS;
        return -1;
    }
    return real_close(fd);
}

/* A Unix socket rejects TCP/IP-level options that HTTP clients set as a matter
 * of course (TCP_NODELAY is the common one). Report success instead of letting
 * an ENOPROTOOPT surface as a connection failure in the caller. */
int setsockopt(int fd, int level, int optname, const void *optval, socklen_t optlen) {
    net_shim_init();
    if (is_tracked(fd) && (level == IPPROTO_TCP || level == IPPROTO_IP || level == IPPROTO_IPV6)) {
        return 0;
    }
    if (real_setsockopt == NULL) {
        errno = ENOSYS;
        return -1;
    }
    return real_setsockopt(fd, level, optname, optval, optlen);
}

/* The local-address counterpart, and not cosmetic: a client that asks the
 * kernel what family its own socket is gets AF_UNIX and concludes the socket
 * cannot carry IP options. Node's built-in fetch() is exactly that client —
 * undici sets the IP type-of-service byte before writing the request, the
 * runtime checks the family first, and the mismatch surfaces as an uncaught
 * `setTypeOfService EINVAL` that kills the process before a single byte is
 * sent. Interposing setsockopt alone does not help, because the option is
 * never attempted. Verified against the shipped Node 24.15.0: node:http worked
 * either way, fetch() only with this. */
int getsockname(int fd, struct sockaddr *addr, socklen_t *len) {
    net_shim_init();
    if (is_tracked(fd) && addr != NULL && len != NULL && *len >= (socklen_t)sizeof(struct sockaddr_in)) {
        struct sockaddr_in in;
        memset(&in, 0, sizeof(in));
        in.sin_family = AF_INET;
        /* An ephemeral local port is what a connected TCP socket would report;
         * nothing in the jail can bind or reach it, so the value only has to
         * be shaped like one. */
        in.sin_port = 0;
        in.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        memcpy(addr, &in, sizeof(in));
        *len = sizeof(in);
        return 0;
    }
    if (real_getsockname == NULL) {
        errno = ENOSYS;
        return -1;
    }
    return real_getsockname(fd, addr, len);
}

/* Clients that introspect the peer (logging, some TLS paths) would otherwise
 * see an AF_UNIX address with an empty path and misbehave. Hand back the
 * address they believe they connected to. */
int getpeername(int fd, struct sockaddr *addr, socklen_t *len) {
    net_shim_init();
    if (is_tracked(fd) && addr != NULL && len != NULL && *len >= (socklen_t)sizeof(struct sockaddr_in)) {
        struct sockaddr_in in;
        memset(&in, 0, sizeof(in));
        in.sin_family = AF_INET;
        in.sin_port = htons(proxy_port);
        in.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        memcpy(addr, &in, sizeof(in));
        *len = sizeof(in);
        return 0;
    }
    if (real_getpeername == NULL) {
        errno = ENOSYS;
        return -1;
    }
    return real_getpeername(fd, addr, len);
}
