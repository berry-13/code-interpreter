#!/bin/bash
set -e

KVM_ENABLED="${KVM_ENABLED:-true}"

if [ "$KVM_ENABLED" = "true" ]; then
    if [ ! -e /dev/kvm ] || [ ! -r /dev/kvm ] || [ ! -w /dev/kvm ]; then
        echo "ERROR: KVM_ENABLED=true but this host has no usable /dev/kvm." >&2
        echo "" >&2
        echo "The container expected hardware virtualization (microVM mode), but" >&2
        echo "/dev/kvm is missing or not readable/writable inside the container." >&2
        echo "This is common on cheap VPSes, LXC containers, and hosts without" >&2
        echo "nested KVM passthrough." >&2
        echo "" >&2
        echo "To run without KVM, use the NsJail-only override:" >&2
        echo "  docker compose -f docker-compose.yaml -f docker-compose.nokvm.yml up" >&2
        echo "" >&2
        echo "Trade-off: NsJail-only mode shares the host kernel and provides" >&2
        echo "meaningfully weaker isolation than microVM mode. It is appropriate for" >&2
        echo "local development and trusted use, not for executing untrusted code" >&2
        echo "from people you don't trust. See the Security disclaimer in README.md." >&2
        exit 1
    fi
    exec /usr/local/bin/launcher-entrypoint.sh "$@"
fi

exec /usr/local/bin/start-direct-sandbox.sh "$@"
