#!/usr/bin/env bash
#
# Package builder for Code Interpreter API
# Installs Python, Node, Bun, and Bash runtime packages for the NsJail sandbox.
# Works on both arm64 (Apple Silicon) and amd64 (Linux/WSL).
#
# Usage:
#   ./build-packages.sh              # Build all packages
#
# Environment Variables:
#   PYTHON_VERSION=3.14.4    # Python version to install
#   NODE_VERSION=24.15.0     # Node.js version to install
#   BUN_VERSION=1.3.14       # Bun version to install
#   BASH_PACKAGE_VERSION=5.2.0 # Bash package registration version (semver-like x.y.z)
#   JAVA_VERSION=21.0.11     # Temurin JDK version to install
#   TEMURIN_BUILD=10         # Temurin build number matching JAVA_VERSION
#   SKIP_PYTHON_PACKAGES=1   # Skip Python pip packages
#   SKIP_JS_PACKAGES=1       # Skip JavaScript npm packages for Node/Bun
#   SKIP_NODE=1              # Skip Node.js installation
#   SKIP_BUN=1               # Skip Bun installation
#   SKIP_PYTHON=1            # Skip Python installation
#   SKIP_JAVA=1              # Skip Java installation
#   FORCE_REBUILD=1          # Delete existing packages first
#   BUN_PACKAGE_BATCH_SIZE=4 # Positive integer number of direct JS packages per Bun install batch
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

PYTHON_VERSION="${PYTHON_VERSION:-3.14.4}"
NODE_VERSION="${NODE_VERSION:-24.15.0}"
BUN_VERSION="${BUN_VERSION:-1.3.14}"
JAVA_VERSION="${JAVA_VERSION:-21.0.11}"
TEMURIN_BUILD="${TEMURIN_BUILD:-10}"
PACKAGES_DIR="./data/pkgs"

# Pinned SHA-256 for the default runtime versions, per arch. Independent,
# git-reviewed record so a tampered upstream release is caught even if its own
# published checksum file is tampered to match. Non-default versions fall back
# to the upstream checksum file (transit integrity only); override with the
# matching <ARTIFACT>_SHA256 to pin a custom version. Keep in sync with
# docker/package-init.sh; update the hash here when bumping a default version.
pinned_sha256() {
    # args: artifact identity arch
    case "$1:$2:$3" in
        python:3.14.4+20260414:x86_64)   echo "e17275eaf95ceb5877aa6816e209b7733f41fee401d39c3921b88fb73fc4a4ba" ;;
        python:3.14.4+20260414:aarch64)  echo "5c8db1c21023316adad827a46d917bbbd6a85ae4e39bc3a58febda712c2f963d" ;;
        # CPython source tarball (this builder compiles from source; python.org
        # publishes no .sha256 sibling, so the source hash is pinned here).
        python-src:3.14.4:any)           echo "d923c51303e38e249136fc1bdf3568d56ecb03214efdef48516176d3d7faaef8" ;;
        node:24.15.0:x64)                echo "472655581fb851559730c48763e0c9d3bc25975c59d518003fc0849d3e4ba0f6" ;;
        node:24.15.0:arm64)              echo "f3d5a797b5d210ce8e2cb265544c8e482eaedcb8aa409a8b46da7e8595d0dda0" ;;
        bun:1.3.14:x64)                  echo "951ee2aee855f08595aeec6225226a298d3fea83a3dcd6465c09cbccdf7e848f" ;;
        bun:1.3.14:aarch64)              echo "a27ffb63a8310375836e0d6f668ae17fa8d8d18b88c37c821c65331973a19a3b" ;;
        java:21.0.11+10:x64)             echo "4b2220e232a97997b436ca6ab15cbf70171ecff52958a46159dfa5a8c44ca4de" ;;
        java:21.0.11+10:aarch64)         echo "8d498ec88e1c1989fab95c6784240ab92d011e29c54d20a3f9c324b13476f9ad" ;;
    esac
}

# expected_sha256 <artifact> <identity> <arch> <checksum_url> <asset_name> <override>
# Resolution order: explicit override -> pinned default -> upstream checksum
# file. Prints the hash, or nothing (a hard failure for the caller).
expected_sha256() {
    local artifact="$1" identity="$2" arch="$3" checksum_url="$4" asset="$5" override="$6"
    if [ -n "$override" ]; then
        echo "$override"
        return 0
    fi
    local pinned
    pinned="$(pinned_sha256 "$artifact" "$identity" "$arch")"
    if [ -n "$pinned" ]; then
        echo "$pinned"
        return 0
    fi
    curl -fsSL "$checksum_url" 2>/dev/null | awk -v a="$asset" '$2 == a || $2 == "*" a { print $1; exit }'
}

# require_sha256: resolve the expected hash and fail closed if none is known.
require_sha256() {
    local expected
    expected="$(expected_sha256 "$@")"
    if [ -z "$expected" ]; then
        echo "ERROR: no known SHA-256 for $1 $2 ($3); refusing to install an unverified download" >&2
        echo "  set the matching <ARTIFACT>_SHA256 env var to pin this version" >&2
        return 1
    fi
    echo "$expected"
}
JS_PACKAGE_MANIFEST="${JS_PACKAGE_MANIFEST:-${SCRIPT_DIR}/javascript-packages.txt}"

load_js_packages() {
    if [ ! -f "$JS_PACKAGE_MANIFEST" ]; then
        echo "Missing JavaScript package manifest: $JS_PACKAGE_MANIFEST"
        exit 1
    fi

    JS_PACKAGES=()
    while IFS= read -r package_spec || [ -n "$package_spec" ]; do
        [[ "$package_spec" =~ ^[[:space:]]*(#|$) ]] && continue
        JS_PACKAGES+=("$package_spec")
    done < "$JS_PACKAGE_MANIFEST"
    if [ "${#JS_PACKAGES[@]}" -eq 0 ]; then
        echo "JavaScript package manifest is empty: $JS_PACKAGE_MANIFEST"
        exit 1
    fi
}

should_load_js_packages() {
    [ "${SKIP_JS_PACKAGES:-}" != "1" ] &&
        { [ "${SKIP_NODE:-}" != "1" ] || [ "${SKIP_BUN:-}" != "1" ]; }
}

validate_bun_package_batch_size() {
    local batch_size="${BUN_PACKAGE_BATCH_SIZE:-4}"
    if [[ ! "$batch_size" =~ ^[1-9][0-9]*$ ]]; then
        echo "ERROR: BUN_PACKAGE_BATCH_SIZE must be a positive integer (got: ${batch_size})" >&2
        return 1
    fi
    printf '%s\n' "$batch_size"
}

if should_load_js_packages; then
    load_js_packages
else
    JS_PACKAGES=()
fi

ARCH=$(uname -m)
case "$ARCH" in
    x86_64)  BUN_ARCH="x64"; NODE_ARCH="x64"; JAVA_ARCH="x64"; echo "Detected: amd64 (Linux/WSL)" ;;
    arm64|aarch64) BUN_ARCH="aarch64"; NODE_ARCH="arm64"; JAVA_ARCH="aarch64"; echo "Detected: arm64 (Apple Silicon)" ;;
    *) echo "Unsupported architecture: $ARCH"; exit 1 ;;
esac

if [ "${FORCE_REBUILD:-}" = "1" ]; then
    echo "Force rebuild requested, cleaning existing packages..."
    docker run --rm -v "$PWD/data/pkgs:/pkgs" alpine sh -c "rm -rf /pkgs/*" 2>/dev/null || rm -rf "$PACKAGES_DIR"/*
fi

mkdir -p "$PACKAGES_DIR"

CONTAINER_NAME="pkg-builder-$$"
cleanup() {
    echo "Cleaning up..."
    docker stop "$CONTAINER_NAME" 2>/dev/null || true
    docker rm "$CONTAINER_NAME" 2>/dev/null || true
}
trap cleanup EXIT

install_python() {
    if [ "${SKIP_PYTHON:-}" = "1" ]; then
        echo "Skipping Python (SKIP_PYTHON=1)"
        return 0
    fi

    local pkg_dest="/pkgs/python/${PYTHON_VERSION}"
    local python_minor="${PYTHON_VERSION%.*}"

    echo "=============================================="
    echo "  Installing Python ${PYTHON_VERSION}"
    echo "=============================================="

    local expected
    expected="$(require_sha256 python-src "$PYTHON_VERSION" any "" "Python-${PYTHON_VERSION}.tar.xz" "${PYTHON_SHA256:-}")" || return 1

    docker exec -e EXPECTED_SHA="$expected" "$CONTAINER_NAME" bash -c "
        set -e
        mkdir -p ${pkg_dest}
        rm -f ${pkg_dest}/.package-installed
        cd /tmp
        wget -q https://www.python.org/ftp/python/${PYTHON_VERSION}/Python-${PYTHON_VERSION}.tar.xz
        echo \"\$EXPECTED_SHA  Python-${PYTHON_VERSION}.tar.xz\" | sha256sum -c -
        tar xf Python-${PYTHON_VERSION}.tar.xz
        cd Python-${PYTHON_VERSION}
        ./configure --prefix=${pkg_dest} --enable-optimizations 2>/dev/null
        make -j\$(nproc)
        make install
        rm -rf /tmp/Python-${PYTHON_VERSION}*
    "

    docker exec "$CONTAINER_NAME" bash -c "cat > ${pkg_dest}/pkg-info.json << 'EOF'
{
    \"language\": \"python\",
    \"version\": \"${PYTHON_VERSION}\",
    \"build_platform\": \"docker-debian\",
    \"aliases\": [\"py\", \"py3\", \"python3\", \"python${python_minor}\"]
}
EOF"

    docker exec "$CONTAINER_NAME" bash -c "cat > ${pkg_dest}/run << 'EOF'
#!/bin/bash
SCRIPT_DIR=\"\$(cd \"\$(dirname \"\${BASH_SOURCE[0]}\")\" && pwd)\"
\"\${SCRIPT_DIR}/bin/python3\" \"\$@\"
EOF
chmod +x ${pkg_dest}/run"

    docker exec "$CONTAINER_NAME" bash -c "
        echo 'PATH=${pkg_dest}/bin:/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin:.' > ${pkg_dest}/.env
    "

    if [ "${SKIP_PYTHON_PACKAGES:-}" = "1" ]; then
        docker exec "$CONTAINER_NAME" bash -c "echo \$(date +%s)000 > ${pkg_dest}/.package-installed"
    fi

    docker exec "$CONTAINER_NAME" "${pkg_dest}/bin/python3" -m pip install --upgrade pip 2>/dev/null || true

    echo "Python ${PYTHON_VERSION} installed"
}

install_python_packages() {
    if [ "${SKIP_PYTHON:-}" = "1" ] || [ "${SKIP_PYTHON_PACKAGES:-}" = "1" ]; then
        echo "Skipping Python packages (SKIP_PYTHON=1 or SKIP_PYTHON_PACKAGES=1)"
        return 0
    fi

    local pip_path="/pkgs/python/${PYTHON_VERSION}/bin/pip3"

    echo "=============================================="
    echo "  Installing Python packages"
    echo "=============================================="

    # MarkItDown 0.1.x initializes Magika/ONNX at import time; the aarch64
    # onnxruntime wheel segfaults under NsJail. 0.0.2 still supports PPTX via
    # python-pptx without that native dependency.
    local python_packages_installed=false
    if docker exec "$CONTAINER_NAME" "$pip_path" install \
        openpyxl \
        matplotlib \
        numpy \
        pandas \
        lifelines \
        scipy \
        statsmodels \
        pillow \
        scikit-learn \
        scikit-image \
        networkx \
        sympy \
        wordcloud \
        pypdf2 \
        python-docx \
        imageio \
        seaborn \
        plotly \
        beautifulsoup4 \
        tabulate \
        xlrd \
        numba \
        patsy \
        numexpr \
        pyarrow \
        chdb==4.1.6 \
        markitdown==0.0.2 \
        python-pptx \
        xlsxwriter \
        docx2python \
        docxtpl \
        mammoth \
        pdf2image \
        "pdfminer.six" \
        reportlab \
        opencv-python-headless \
        svglib \
        cairosvg \
        exifread \
        hachoir \
        python-barcode \
        qrcode \
        fonttools \
        pytesseract \
        pdfminer \
        vsdx; then
        python_packages_installed=true
    else
        echo "ERROR: Python package installation failed"
        return 1
    fi

    docker exec "$CONTAINER_NAME" "$pip_path" install --upgrade six 2>/dev/null || true
    if [ "$python_packages_installed" = true ]; then
        docker exec "$CONTAINER_NAME" bash -c "echo \$(date +%s)000 > /pkgs/python/${PYTHON_VERSION}/.package-installed"
    fi

    echo "Installed Python packages:"
    docker exec "$CONTAINER_NAME" "$pip_path" list 2>/dev/null | head -20
}

install_node() {
    if [ "${SKIP_NODE:-}" = "1" ]; then
        echo "Skipping Node.js (SKIP_NODE=1)"
        return 0
    fi

    local pkg_dest="/pkgs/node/${NODE_VERSION}"

    echo "=============================================="
    echo "  Installing Node.js ${NODE_VERSION}"
    echo "=============================================="

    local expected
    expected="$(require_sha256 node "$NODE_VERSION" "$NODE_ARCH" \
        "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" \
        "node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz" "${NODE_SHA256:-}")" || return 1

    docker exec -e EXPECTED_SHA="$expected" "$CONTAINER_NAME" bash -c "
        set -e
        mkdir -p ${pkg_dest}
        rm -f ${pkg_dest}/.package-installed
        cd /tmp
        curl -fsSL -o node.tar.xz https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz
        echo \"\$EXPECTED_SHA  node.tar.xz\" | sha256sum -c -
        tar -xJf node.tar.xz --strip-components=1 -C ${pkg_dest}
        rm -f node.tar.xz
    "

    docker exec "$CONTAINER_NAME" bash -c "cat > ${pkg_dest}/pkg-info.json << 'EOF'
{
    \"language\": \"node\",
    \"version\": \"${NODE_VERSION}\",
    \"build_platform\": \"docker-debian\",
    \"aliases\": [\"nodejs\", \"node-js\", \"node-javascript\"]
}
EOF"

    docker exec "$CONTAINER_NAME" bash -c "cat > ${pkg_dest}/run << 'EOF'
#!/bin/bash
SCRIPT_DIR=\"\$(cd \"\$(dirname \"\${BASH_SOURCE[0]}\")\" && pwd)\"
MODULE_DIR=\"\${SCRIPT_DIR}/node_modules\"
if [ -d \"\${MODULE_DIR}\" ] && [ ! -e /mnt/data/node_modules ]; then
    ln -s \"\${MODULE_DIR}\" /mnt/data/node_modules 2>/dev/null || true
fi
\"\${SCRIPT_DIR}/bin/node\" \"\$@\"
EOF
chmod +x ${pkg_dest}/run"

    docker exec "$CONTAINER_NAME" bash -c "
        echo 'PATH=${pkg_dest}/bin:/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin:.' > ${pkg_dest}/.env
        echo 'NODE_PATH=${pkg_dest}/node_modules' >> ${pkg_dest}/.env
    "

    if [ "${SKIP_JS_PACKAGES:-}" = "1" ]; then
        docker exec "$CONTAINER_NAME" bash -c "echo \$(date +%s)000 > ${pkg_dest}/.package-installed"
    fi

    echo "Node.js ${NODE_VERSION} installed: $(docker exec "$CONTAINER_NAME" "${pkg_dest}/bin/node" --version)"
}

install_node_packages() {
    if [ "${SKIP_NODE:-}" = "1" ] || [ "${SKIP_JS_PACKAGES:-}" = "1" ]; then
        echo "Skipping Node.js packages (SKIP_NODE=1 or SKIP_JS_PACKAGES=1)"
        return 0
    fi

    local pkg_dest="/pkgs/node/${NODE_VERSION}"
    local npm_path="${pkg_dest}/bin/npm"

    echo "=============================================="
    echo "  Installing Node.js packages"
    echo "=============================================="

    docker exec "$CONTAINER_NAME" env "PATH=${pkg_dest}/bin:/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin:." "$npm_path" install \
        --prefix "$pkg_dest" \
        --omit=dev \
        --no-audit \
        --no-fund \
        --save-exact \
        --package-lock=false \
        "${JS_PACKAGES[@]}"

    # Mirror the manifest into npm's global tree (${pkg_dest}/lib/node_modules
    # + bin shims on PATH) so `npm list -g`, `npm root -g`, and CLI shims work
    # as LLMs expect. The local tree above is still what feeds the
    # /mnt/data/node_modules symlink used by `require()` from user code.
    docker exec "$CONTAINER_NAME" env "PATH=${pkg_dest}/bin:/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin:." "$npm_path" install -g \
        --prefix "$pkg_dest" \
        --omit=dev \
        --no-audit \
        --no-fund \
        --save-exact \
        "${JS_PACKAGES[@]}"

    docker exec "$CONTAINER_NAME" bash -c "echo \$(date +%s)000 > ${pkg_dest}/.package-installed"

    echo "Installed Node.js packages (local):"
    docker exec "$CONTAINER_NAME" env "PATH=${pkg_dest}/bin:/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin:." "$npm_path" ls --prefix "$pkg_dest" --depth=0 2>/dev/null | head -40 || true

    echo "Installed Node.js packages (global):"
    docker exec "$CONTAINER_NAME" env "PATH=${pkg_dest}/bin:/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin:." "$npm_path" ls -g --prefix "$pkg_dest" --depth=0 2>/dev/null | head -40 || true
}

install_bun() {
    if [ "${SKIP_BUN:-}" = "1" ]; then
        echo "Skipping Bun (SKIP_BUN=1)"
        return 0
    fi

    local pkg_dest="/pkgs/bun/${BUN_VERSION}"

    echo "=============================================="
    echo "  Installing Bun ${BUN_VERSION}"
    echo "=============================================="

    local expected
    expected="$(require_sha256 bun "$BUN_VERSION" "$BUN_ARCH" \
        "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/SHASUMS256.txt" \
        "bun-linux-${BUN_ARCH}.zip" "${BUN_SHA256:-}")" || return 1

    docker exec -e EXPECTED_SHA="$expected" "$CONTAINER_NAME" bash -c "
        set -e
        mkdir -p ${pkg_dest}
        rm -f ${pkg_dest}/.package-installed
        cd /tmp
        curl -fsSL -o bun.zip https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-${BUN_ARCH}.zip
        echo \"\$EXPECTED_SHA  bun.zip\" | sha256sum -c -
        unzip -o bun.zip
        mv bun-linux-${BUN_ARCH}/bun ${pkg_dest}/bun
        chmod +x ${pkg_dest}/bun
        rm -rf bun.zip bun-linux-${BUN_ARCH}
    "

    docker exec "$CONTAINER_NAME" bash -c "cat > ${pkg_dest}/pkg-info.json << 'EOF'
{
    \"language\": \"bun\",
    \"version\": \"${BUN_VERSION}\",
    \"build_platform\": \"docker-debian\",
    \"provides\": [
        { \"language\": \"typescript\", \"aliases\": [\"bun-ts\"] },
        { \"language\": \"javascript\", \"aliases\": [\"bun-js\"] }
    ]
}
EOF"

    docker exec "$CONTAINER_NAME" bash -c "cat > ${pkg_dest}/run << 'EOF'
#!/bin/bash
SCRIPT_DIR=\"\$(cd \"\$(dirname \"\${BASH_SOURCE[0]}\")\" && pwd)\"
MODULE_DIR=\"\${SCRIPT_DIR}/node_modules\"
if [ -d \"\${MODULE_DIR}\" ] && [ ! -e /mnt/data/node_modules ]; then
    ln -s \"\${MODULE_DIR}\" /mnt/data/node_modules 2>/dev/null || true
fi
\"\${SCRIPT_DIR}/bun\" run \"\$@\"
EOF
chmod +x ${pkg_dest}/run"

    docker exec "$CONTAINER_NAME" bash -c "
        echo 'PATH=${pkg_dest}/bin:${pkg_dest}:/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin:.' > ${pkg_dest}/.env
        echo 'NODE_PATH=${pkg_dest}/node_modules' >> ${pkg_dest}/.env
        echo 'BUN_INSTALL=${pkg_dest}' >> ${pkg_dest}/.env
    "

    if [ "${SKIP_JS_PACKAGES:-}" = "1" ]; then
        docker exec "$CONTAINER_NAME" bash -c "echo \$(date +%s)000 > ${pkg_dest}/.package-installed"
    fi

    echo "Bun ${BUN_VERSION} installed: $(docker exec "$CONTAINER_NAME" "${pkg_dest}/bun" --version)"
}

install_bun_packages() {
    if [ "${SKIP_BUN:-}" = "1" ] || [ "${SKIP_JS_PACKAGES:-}" = "1" ]; then
        echo "Skipping Bun packages (SKIP_BUN=1 or SKIP_JS_PACKAGES=1)"
        return 0
    fi

    local pkg_dest="/pkgs/bun/${BUN_VERSION}"
    local batch_size
    batch_size="$(validate_bun_package_batch_size)"
    local batch_index=1
    local batch_count=$(( (${#JS_PACKAGES[@]} + batch_size - 1) / batch_size ))

    echo "=============================================="
    echo "  Installing Bun packages"
    echo "=============================================="

    for ((i = 0; i < ${#JS_PACKAGES[@]}; i += batch_size)); do
        local batch_packages
        printf -v batch_packages "%q " "${JS_PACKAGES[@]:i:batch_size}"
        echo "Installing Bun package batch ${batch_index}/${batch_count}"
        docker exec "$CONTAINER_NAME" bash -c "
            set -e
            cd ${pkg_dest}
            BUN_CONFIG_MAX_HTTP_REQUESTS=${BUN_CONFIG_MAX_HTTP_REQUESTS:-8} ./bun add --exact ${batch_packages}
        "
        batch_index=$((batch_index + 1))
    done

    # Mirror the manifest into bun's global tree (BUN_INSTALL=${pkg_dest} ->
    # ${pkg_dest}/install/global/node_modules) so `bun pm ls -g`, `bun add -g`,
    # and global CLI shims at ${pkg_dest}/install/global/bin work as LLMs
    # expect. The local tree above is still what feeds the
    # /mnt/data/node_modules symlink used by `import` from user code.
    batch_index=1
    for ((i = 0; i < ${#JS_PACKAGES[@]}; i += batch_size)); do
        local batch_packages
        printf -v batch_packages "%q " "${JS_PACKAGES[@]:i:batch_size}"
        echo "Installing global Bun package batch ${batch_index}/${batch_count}"
        docker exec "$CONTAINER_NAME" bash -c "
            set -e
            cd ${pkg_dest}
            BUN_CONFIG_MAX_HTTP_REQUESTS=${BUN_CONFIG_MAX_HTTP_REQUESTS:-8} BUN_INSTALL=${pkg_dest} ./bun install -g --exact ${batch_packages}
        "
        batch_index=$((batch_index + 1))
    done

    docker exec "$CONTAINER_NAME" bash -c "echo \$(date +%s)000 > ${pkg_dest}/.package-installed"

    echo "Installed Bun packages (local):"
    docker exec "$CONTAINER_NAME" bash -c "cd ${pkg_dest} && ./bun pm ls --depth 0 2>/dev/null | head -40" || true

    echo "Installed Bun packages (global):"
    docker exec "$CONTAINER_NAME" bash -c "cd ${pkg_dest} && BUN_INSTALL=${pkg_dest} ./bun pm ls -g 2>/dev/null | head -40" || true
}

install_java() {
    if [ "${SKIP_JAVA:-}" = "1" ]; then
        echo "Skipping Java (SKIP_JAVA=1)"
        return 0
    fi

    local pkg_dest="/pkgs/java/${JAVA_VERSION}"
    local java_feature="${JAVA_VERSION%%.*}"

    echo "=============================================="
    echo "  Installing Java ${JAVA_VERSION}"
    echo "=============================================="

    local java_url="https://github.com/adoptium/temurin${java_feature}-binaries/releases/download/jdk-${JAVA_VERSION}%2B${TEMURIN_BUILD}/OpenJDK${java_feature}U-jdk_${JAVA_ARCH}_linux_hotspot_${JAVA_VERSION}_${TEMURIN_BUILD}.tar.gz"
    local expected
    expected="$(require_sha256 java "${JAVA_VERSION}+${TEMURIN_BUILD}" "$JAVA_ARCH" \
        "${java_url}.sha256.txt" \
        "OpenJDK${java_feature}U-jdk_${JAVA_ARCH}_linux_hotspot_${JAVA_VERSION}_${TEMURIN_BUILD}.tar.gz" \
        "${JAVA_SHA256:-}")" || return 1

    docker exec -e EXPECTED_SHA="$expected" "$CONTAINER_NAME" bash -c "
        set -e
        mkdir -p ${pkg_dest}
        rm -f ${pkg_dest}/.package-installed
        cd /tmp
        curl -fsSL -o java.tar.gz ${java_url}
        echo \"\$EXPECTED_SHA  java.tar.gz\" | sha256sum -c -
        tar -xzf java.tar.gz --strip-components=1 -C ${pkg_dest}
        rm -f java.tar.gz
    "

    docker exec "$CONTAINER_NAME" bash -c "cat > ${pkg_dest}/pkg-info.json << 'EOF'
{
    \"language\": \"java\",
    \"version\": \"${JAVA_VERSION}\",
    \"build_platform\": \"docker-debian\",
    \"aliases\": [\"jdk\", \"openjdk\", \"temurin\"]
}
EOF"

    docker exec "$CONTAINER_NAME" bash -c "cat > ${pkg_dest}/compile << 'EOF'
#!/bin/bash
SCRIPT_DIR=\"\$(cd \"\$(dirname \"\${BASH_SOURCE[0]}\")\" && pwd)\"
# The sandbox passes every submitted file; attachments like data.csv are
# inputs for the program, not compilation units.
SOURCES=()
for f in \"\$@\"; do
    case \"\$f\" in
        *.java) SOURCES+=(\"\$f\") ;;
    esac
done
exec \"\${SCRIPT_DIR}/bin/javac\" \"\${SOURCES[@]}\"
EOF
chmod +x ${pkg_dest}/compile"

    docker exec "$CONTAINER_NAME" bash -c "cat > ${pkg_dest}/run << 'EOF'
#!/bin/bash
SCRIPT_DIR=\"\$(cd \"\$(dirname \"\${BASH_SOURCE[0]}\")\" && pwd)\"
CLASS=\"\$(basename \"\${1%.java}\")\"
shift
exec \"\${SCRIPT_DIR}/bin/java\" -XX:+UseSerialGC -cp . \"\$CLASS\" \"\$@\"
EOF
chmod +x ${pkg_dest}/run"

    docker exec "$CONTAINER_NAME" bash -c "
        echo 'PATH=${pkg_dest}/bin:/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin:.' > ${pkg_dest}/.env
        echo 'JAVA_HOME=${pkg_dest}' >> ${pkg_dest}/.env
        echo '${TEMURIN_BUILD}' > ${pkg_dest}/.temurin-build
        echo \$(date +%s)000 > ${pkg_dest}/.package-installed
    "

    echo "Java ${JAVA_VERSION} installed: $(docker exec "$CONTAINER_NAME" "${pkg_dest}/bin/java" --version | head -1)"
}

install_bash() {
    local bash_package_version
    bash_package_version="${BASH_PACKAGE_VERSION:-5.2.0}"
    local system_bash_version
    system_bash_version=$(docker exec "$CONTAINER_NAME" bash --version | head -1 | sed -E 's/.* ([0-9]+\.[0-9]+\.[0-9]+).*/\1/')
    local pkg_dest="/pkgs/bash/${bash_package_version}"

    echo "=============================================="
    echo "  Registering Bash ${bash_package_version}"
    echo "=============================================="

    docker exec "$CONTAINER_NAME" bash -c "
        mkdir -p ${pkg_dest}
    "

    docker exec "$CONTAINER_NAME" bash -c "cat > ${pkg_dest}/pkg-info.json << 'PKGEOF'
{
    \"language\": \"bash\",
    \"version\": \"${bash_package_version}\",
    \"build_platform\": \"docker-debian\",
    \"system_version\": \"${system_bash_version}\",
    \"aliases\": [\"sh\"]
}
PKGEOF"

    docker exec "$CONTAINER_NAME" bash -c "cat > ${pkg_dest}/run << 'RUNEOF'
#!/bin/bash
bash \"\$@\"
RUNEOF
chmod +x ${pkg_dest}/run"

    # Surface node + bun toolchains and their global trees on PATH so bash
    # tool invocations (which is how LLMs typically reach for `npm list -g`,
    # `bun pm ls -g`, `handlebars`, etc.) discover the manifest packages.
    # BUN_INSTALL points bun at the bun runtime's BUN_INSTALL root so
    # `bun pm ls -g` resolves the offline globals instead of falling back
    # to ~/.bun/install/global.
    docker exec "$CONTAINER_NAME" bash -c "
        cat > ${pkg_dest}/.env <<EOF
PATH=/pkgs/bun/${BUN_VERSION}/bin:/pkgs/bun/${BUN_VERSION}:/pkgs/node/${NODE_VERSION}/bin:/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin:.
NODE_PATH=/pkgs/node/${NODE_VERSION}/node_modules
BUN_INSTALL=/pkgs/bun/${BUN_VERSION}
EOF
        echo \$(date +%s)000 > ${pkg_dest}/.package-installed
    "

    echo "Bash ${bash_package_version} registered (using system binary ${system_bash_version})"
}

main() {
    echo "=============================================="
    echo "  Code Interpreter API - Package Builder"
    echo "=============================================="
    echo ""

    command -v docker >/dev/null 2>&1 || { echo "Docker is required"; exit 1; }

    echo "Starting builder container..."
    docker run \
        -v "$PWD/data/pkgs:/pkgs" \
        -dit \
        --name "$CONTAINER_NAME" \
        buildpack-deps:bookworm >/dev/null

    echo "Installing system dependencies..."
    docker exec "$CONTAINER_NAME" bash -c "
        apt-get update && apt-get install -y --no-install-recommends \
            curl unzip wget ca-certificates \
            build-essential libssl-dev libffi-dev libsqlite3-dev \
            zlib1g-dev libbz2-dev libreadline-dev libncurses5-dev \
            tk-dev xz-utils libcurl4-openssl-dev libfontconfig1-dev \
            libudunits2-dev libpng-dev libxml2-dev libcairo2-dev \
            libfreetype6-dev \
        && rm -rf /var/lib/apt/lists/*
    "

    install_python
    install_python_packages
    install_node
    install_node_packages
    install_bun
    install_bun_packages
    install_java
    install_bash

    echo "Setting permissions..."
    chmod -R a+rX "$PACKAGES_DIR" 2>/dev/null || true

    echo ""
    echo "=============================================="
    echo "  Build complete!"
    echo "=============================================="
    echo ""
    echo "Packages installed to: $PACKAGES_DIR"
    echo ""
    echo "Next steps:"
    echo "  1. Run: docker compose up --build"
    echo ""
}

main "$@"
