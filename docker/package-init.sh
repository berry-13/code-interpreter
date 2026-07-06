#!/bin/bash
#
# Package Init Script
# Installs Python, Node, Bun, and Bash runtime packages for the NsJail sandbox.
# Runs inside the package-init container to populate the packages PVC.
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MARKER_FILE="/pkgs/.initialized"
FORCE_REBUILD="${FORCE_REBUILD:-false}"
PYTHON_VERSION="${PYTHON_VERSION:-3.14.4}"
PYTHON_SITE_VERSION="${PYTHON_VERSION%.*}"
PYTHON_ALIAS="python${PYTHON_SITE_VERSION}"
NODE_VERSION="${NODE_VERSION:-24.15.0}"
BUN_VERSION="${BUN_VERSION:-1.3.14}"
BASH_PACKAGE_VERSION="${BASH_PACKAGE_VERSION:-5.2.0}"
JAVA_VERSION="${JAVA_VERSION:-21.0.11}"
TEMURIN_BUILD="${TEMURIN_BUILD:-10}"
CODEAPI_LANGUAGES="${CODEAPI_LANGUAGES:-python,node,bun,bash,java}"
INSTALL_FAILED=false
JS_PACKAGE_MANIFEST="${JS_PACKAGE_MANIFEST:-${SCRIPT_DIR}/javascript-packages.txt}"

SELECTED_LANGUAGES=()
IFS=',' read -ra REQUESTED_LANGUAGES <<< "$CODEAPI_LANGUAGES"
for lang in "${REQUESTED_LANGUAGES[@]}"; do
    lang="$(echo "$lang" | tr -d '[:space:]')"
    [ -n "$lang" ] || continue
    case "$lang" in
        python|node|bun|bash|java)
            SELECTED_LANGUAGES+=("$lang")
            ;;
        *)
            echo "ERROR: Unknown language in CODEAPI_LANGUAGES: '${lang}'" >&2
            echo "Supported languages: python, node, bun, bash, java" >&2
            exit 1
            ;;
    esac
done
if [ "${#SELECTED_LANGUAGES[@]}" -eq 0 ]; then
    echo "ERROR: CODEAPI_LANGUAGES does not select any languages (got: '${CODEAPI_LANGUAGES}')" >&2
    echo "Supported languages: python, node, bun, bash, java" >&2
    exit 1
fi
SELECTED_LANGUAGES_CSV="$(IFS=','; echo "${SELECTED_LANGUAGES[*]}")"

language_selected() {
    local lang
    for lang in "${SELECTED_LANGUAGES[@]}"; do
        [ "$lang" = "$1" ] && return 0
    done
    return 1
}

load_js_packages() {
    if [ ! -f "$JS_PACKAGE_MANIFEST" ]; then
        echo "ERROR: Missing JavaScript package manifest: $JS_PACKAGE_MANIFEST"
        INSTALL_FAILED=true
        JS_PACKAGES=()
        return
    fi

    JS_PACKAGES=()
    while IFS= read -r package_spec || [ -n "$package_spec" ]; do
        [[ "$package_spec" =~ ^[[:space:]]*(#|$) ]] && continue
        JS_PACKAGES+=("$package_spec")
    done < "$JS_PACKAGE_MANIFEST"
    if [ "${#JS_PACKAGES[@]}" -eq 0 ]; then
        echo "ERROR: JavaScript package manifest is empty: $JS_PACKAGE_MANIFEST"
        INSTALL_FAILED=true
    fi
}

validate_bun_package_batch_size() {
    local batch_size="${BUN_PACKAGE_BATCH_SIZE:-4}"
    if [[ ! "$batch_size" =~ ^[1-9][0-9]*$ ]]; then
        echo "ERROR: BUN_PACKAGE_BATCH_SIZE must be a positive integer (got: ${batch_size})" >&2
        return 1
    fi
    printf '%s\n' "$batch_size"
}

package_name_from_spec() {
    local spec="$1"
    echo "${spec%@*}"
}

package_version_from_spec() {
    local spec="$1"
    echo "${spec##*@}"
}

js_packages_ready() {
    local pkg_root="$1"
    local spec package_name package_version package_json
    [ "${#JS_PACKAGES[@]}" -gt 0 ] || return 1
    for spec in "${JS_PACKAGES[@]}"; do
        package_name="$(package_name_from_spec "$spec")"
        package_version="$(package_version_from_spec "$spec")"
        package_json="${pkg_root}/node_modules/${package_name}/package.json"
        [ -f "$package_json" ] || return 1
        if [ "$package_name" != "$package_version" ]; then
            grep -F "\"version\": \"${package_version}\"" "$package_json" >/dev/null || return 1
        fi
    done
}

JS_PACKAGES=()
if language_selected node || language_selected bun; then
    load_js_packages
fi

echo "=============================================="
echo "  Code Interpreter - Package Init"
echo "=============================================="
echo ""
echo "Selected languages: ${SELECTED_LANGUAGES_CSV}"
echo ""

python_ready() {
    [ -f "/pkgs/python/${PYTHON_VERSION}/.package-installed" ] &&
    [ -d "/pkgs/python/${PYTHON_VERSION}/lib/python${PYTHON_SITE_VERSION}/site-packages/PIL" ] &&
    [ -d "/pkgs/python/${PYTHON_VERSION}/lib/python${PYTHON_SITE_VERSION}/site-packages/markitdown" ] &&
    [ -d "/pkgs/python/${PYTHON_VERSION}/lib/python${PYTHON_SITE_VERSION}/site-packages/chdb" ] &&
    [ -d "/pkgs/python/${PYTHON_VERSION}/lib/python${PYTHON_SITE_VERSION}/site-packages/statsmodels" ] &&
    [ -d "/pkgs/python/${PYTHON_VERSION}/lib/python${PYTHON_SITE_VERSION}/site-packages/dill" ]
}

node_ready() {
    [ -f "/pkgs/node/${NODE_VERSION}/.package-installed" ] &&
    js_packages_ready "/pkgs/node/${NODE_VERSION}"
}

bun_ready() {
    [ -f "/pkgs/bun/${BUN_VERSION}/.package-installed" ] &&
    js_packages_ready "/pkgs/bun/${BUN_VERSION}"
}

bash_ready() {
    [ -f "/pkgs/bash/${BASH_PACKAGE_VERSION}/.package-installed" ]
}

java_installed_build() {
    local dest="/pkgs/java/${JAVA_VERSION}"
    if [ -f "$dest/.temurin-build" ]; then
        cat "$dest/.temurin-build"
    else
        # Volumes populated before the build marker existed: read the build
        # from the JDK's own release file (JAVA_RUNTIME_VERSION="21.0.11+10-LTS")
        # so a matching install is kept instead of re-downloaded.
        sed -n 's/^JAVA_RUNTIME_VERSION="[^+]*+\([0-9][0-9]*\).*/\1/p' "$dest/release" 2>/dev/null
    fi
}

java_ready() {
    [ -f "/pkgs/java/${JAVA_VERSION}/.package-installed" ] &&
    [ "$(java_installed_build)" = "$TEMURIN_BUILD" ]
}

packages_ready() {
    if language_selected python; then python_ready || return 1; fi
    if language_selected node; then node_ready || return 1; fi
    if language_selected bun; then bun_ready || return 1; fi
    if language_selected bash; then bash_ready || return 1; fi
    if language_selected java; then java_ready || return 1; fi
}

if [ -f "$MARKER_FILE" ] && [ "$FORCE_REBUILD" != "true" ]; then
    if packages_ready; then
        echo "Packages already initialized (marker file exists)"
        echo "Set FORCE_REBUILD=true to force reinstall"
        echo ""
        echo "Installed packages:"
        ls -la /pkgs/ 2>/dev/null || echo "  (none)"
        exit 0
    fi
    echo "Initialization marker exists, but one or more required packages are missing"
    echo "Continuing package initialization"
fi

if [ "$FORCE_REBUILD" = "true" ] && [ -d "/pkgs" ]; then
    echo "Force rebuild requested, cleaning existing packages..."
    rm -rf /pkgs/* /pkgs/.initialized
fi

# ==============================
# Install Python
# ==============================
if ! language_selected python; then
    echo ""
    echo "Skipping Python (not in CODEAPI_LANGUAGES)"
elif python_ready; then
    echo ""
    echo "Python ${PYTHON_VERSION} already installed, skipping"
else
    echo ""
    echo "=============================================="
    echo "  Installing Python ${PYTHON_VERSION}"
    echo "=============================================="
    echo ""

    PKG_DEST="/pkgs/python/${PYTHON_VERSION}"
    mkdir -p "$PKG_DEST"
    rm -f "$PKG_DEST/.package-installed"

    ARCH=$(uname -m)
    case "$ARCH" in
        x86_64) PYTHON_ARCH="x86_64" ;;
        aarch64|arm64) PYTHON_ARCH="aarch64" ;;
        *)
            echo "ERROR: Unsupported architecture for Python: $ARCH" >&2
            exit 1
            ;;
    esac

    # Prebuilt CPython from astral-sh/python-build-standalone: installs in
    # seconds instead of the 15+ minutes a from-source PGO build takes. The
    # release tag is pinned because python-build-standalone drops older point
    # releases from newer tags; override both together to change versions.
    PYTHON_BUILD_STANDALONE_TAG="${PYTHON_BUILD_STANDALONE_TAG:-20260414}"
    PYTHON_URL="https://github.com/astral-sh/python-build-standalone/releases/download/${PYTHON_BUILD_STANDALONE_TAG}/cpython-${PYTHON_VERSION}+${PYTHON_BUILD_STANDALONE_TAG}-${PYTHON_ARCH}-unknown-linux-gnu-install_only.tar.gz"
    cd /tmp
    if ! curl -fsSL "$PYTHON_URL" -o python.tar.gz; then
        echo "ERROR: Failed to download prebuilt Python from $PYTHON_URL" >&2
        echo "Check that release ${PYTHON_BUILD_STANDALONE_TAG} provides cpython ${PYTHON_VERSION}" >&2
        echo "(set PYTHON_BUILD_STANDALONE_TAG and PYTHON_VERSION together to change versions)" >&2
        exit 1
    fi
    tar -xzf python.tar.gz --strip-components=1 -C "$PKG_DEST"
    rm -f python.tar.gz

    cat > "$PKG_DEST/pkg-info.json" << EOF
{
    "language": "python",
    "version": "${PYTHON_VERSION}",
    "build_platform": "docker-debian",
    "aliases": ["py", "py3", "python3", "${PYTHON_ALIAS}"]
}
EOF

    cat > "$PKG_DEST/run" << 'EOF'
#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
"${SCRIPT_DIR}/bin/python3" "$@"
EOF
    chmod +x "$PKG_DEST/run"

    echo "PATH=${PKG_DEST}/bin:/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin:." > "$PKG_DEST/.env"

    echo "Python ${PYTHON_VERSION} installed"

    # ==============================
    # Install Python packages
    # ==============================
    echo ""
    echo "=============================================="
    echo "  Installing Python packages"
    echo "=============================================="
    echo ""

    PIP_PATH="${PKG_DEST}/bin/pip3"
    if [ -f "$PIP_PATH" ]; then
        "$PIP_PATH" install --upgrade pip 2>/dev/null || true
        PYTHON_PACKAGES_INSTALLED=false

        # MarkItDown 0.1.x initializes Magika/ONNX at import time; the aarch64
        # onnxruntime wheel segfaults under NsJail. 0.0.2 still supports PPTX via
        # python-pptx without that native dependency.
        if ! "$PIP_PATH" install \
            openpyxl \
            matplotlib \
            numpy \
            pandas \
            dill \
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
            echo "ERROR: Python package installation failed"
            INSTALL_FAILED=true
        else
            PYTHON_PACKAGES_INSTALLED=true
        fi

        "$PIP_PATH" install --upgrade six 2>/dev/null || true
        if [ "$PYTHON_PACKAGES_INSTALLED" = true ]; then
            echo "$(date +%s)000" > "$PKG_DEST/.package-installed"
        fi

        echo ""
        echo "Installed Python packages:"
        "$PIP_PATH" list 2>/dev/null | head -20
    else
        echo "ERROR: pip not found at $PIP_PATH"
        INSTALL_FAILED=true
    fi
fi

# ==============================
# Install Node.js
# ==============================
if ! language_selected node; then
    echo ""
    echo "Skipping Node.js (not in CODEAPI_LANGUAGES)"
elif node_ready; then
    echo ""
    echo "Node.js ${NODE_VERSION} already installed, skipping"
else
    echo ""
    echo "=============================================="
    echo "  Installing Node.js ${NODE_VERSION}"
    echo "=============================================="
    echo ""

    NODE_DEST="/pkgs/node/${NODE_VERSION}"
    mkdir -p "$NODE_DEST"
    rm -f "$NODE_DEST/.package-installed"
    NODE_INSTALLED=false

    ARCH=$(uname -m)
    case "$ARCH" in
        x86_64) NODE_ARCH="x64" ;;
        aarch64|arm64) NODE_ARCH="arm64" ;;
        *)
            echo "ERROR: Unsupported architecture for Node.js: $ARCH"
            NODE_ARCH=""
            INSTALL_FAILED=true
            ;;
    esac

    if [ -n "$NODE_ARCH" ]; then
        NODE_URL="https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"
        cd /tmp
        if curl -fsSL "$NODE_URL" -o node.tar.xz; then
            if tar -xJf node.tar.xz --strip-components=1 -C "$NODE_DEST"; then
                rm -f node.tar.xz

                cat > "$NODE_DEST/pkg-info.json" << EOF
{
    "language": "node",
    "version": "${NODE_VERSION}",
    "build_platform": "docker-debian",
    "aliases": ["nodejs", "node-js", "node-javascript"]
}
EOF

                cat > "$NODE_DEST/run" << 'EOF'
#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODULE_DIR="${SCRIPT_DIR}/node_modules"
if [ -d "$MODULE_DIR" ] && [ ! -e /mnt/data/node_modules ]; then
    ln -s "$MODULE_DIR" /mnt/data/node_modules 2>/dev/null || true
fi
"${SCRIPT_DIR}/bin/node" "$@"
EOF
                chmod +x "$NODE_DEST/run"

                {
                    echo "PATH=${NODE_DEST}/bin:/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin:."
                    echo "NODE_PATH=${NODE_DEST}/node_modules"
                } > "$NODE_DEST/.env"

                NODE_INSTALLED=true
                echo "Node.js ${NODE_VERSION} installed: $($NODE_DEST/bin/node --version)"
            else
                echo "ERROR: Failed to extract Node.js archive"
                rm -f node.tar.xz
                INSTALL_FAILED=true
            fi
        else
            echo "ERROR: Failed to download Node.js"
            INSTALL_FAILED=true
        fi
    fi

    # ==============================
    # Install JavaScript packages for Node.js
    # ==============================
    echo ""
    echo "=============================================="
    echo "  Installing Node.js packages"
    echo "=============================================="
    echo ""

    NODE_NPM="${NODE_DEST}/bin/npm"
    if [ "$NODE_INSTALLED" = true ] && [ "${#JS_PACKAGES[@]}" -gt 0 ] && [ -f "$NODE_NPM" ]; then
        if ! PATH="${NODE_DEST}/bin:$PATH" "$NODE_NPM" install \
            --prefix "$NODE_DEST" \
            --omit=dev \
            --no-audit \
            --no-fund \
            --save-exact \
            --package-lock=false \
            "${JS_PACKAGES[@]}"; then
            echo "ERROR: Node.js package installation failed"
            INSTALL_FAILED=true
        else
            echo "$(date +%s)000" > "$NODE_DEST/.package-installed"
        fi

        echo ""
        echo "Installed Node.js packages:"
        PATH="${NODE_DEST}/bin:$PATH" "$NODE_NPM" ls --prefix "$NODE_DEST" --depth=0 2>/dev/null | head -40 || true
    elif [ "$NODE_INSTALLED" = true ] && [ "${#JS_PACKAGES[@]}" -eq 0 ]; then
        echo "ERROR: No JavaScript packages loaded for Node.js"
        INSTALL_FAILED=true
    elif [ "$NODE_INSTALLED" = true ]; then
        echo "ERROR: npm not found at $NODE_NPM"
        INSTALL_FAILED=true
    else
        echo "Skipping Node.js package installation because Node.js was not installed"
    fi
fi

# ==============================
# Install Bun
# ==============================
if ! language_selected bun; then
    echo ""
    echo "Skipping Bun (not in CODEAPI_LANGUAGES)"
elif bun_ready; then
    echo ""
    echo "Bun ${BUN_VERSION} already installed, skipping"
else
    echo ""
    echo "=============================================="
    echo "  Installing Bun ${BUN_VERSION}"
    echo "=============================================="
    echo ""

    BUN_DEST="/pkgs/bun/${BUN_VERSION}"
    mkdir -p "$BUN_DEST"
    rm -f "$BUN_DEST/.package-installed"
    BUN_INSTALLED=false

    ARCH=$(uname -m)
    case "$ARCH" in
        x86_64)  BUN_ARCH="x64" ;;
        aarch64|arm64) BUN_ARCH="aarch64" ;;
        *)
            echo "ERROR: Unsupported architecture for Bun: $ARCH"
            BUN_ARCH=""
            INSTALL_FAILED=true
            ;;
    esac

    if [ -n "$BUN_ARCH" ]; then
        BUN_URL="https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-${BUN_ARCH}.zip"
        cd /tmp
        if curl -fsSL "$BUN_URL" -o bun.zip; then
            if unzip -o bun.zip && mv bun-linux-${BUN_ARCH}/bun "$BUN_DEST/"; then
                chmod +x "$BUN_DEST/bun"
                rm -rf bun.zip bun-linux-${BUN_ARCH}

                cat > "$BUN_DEST/pkg-info.json" << EOF
{
    "language": "bun",
    "version": "${BUN_VERSION}",
    "build_platform": "docker-debian",
    "provides": [
        { "language": "typescript", "aliases": ["bun-ts"] },
        { "language": "javascript", "aliases": ["bun-js"] }
    ]
}
EOF

                cat > "$BUN_DEST/run" << 'EOF'
#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODULE_DIR="${SCRIPT_DIR}/node_modules"
if [ -d "$MODULE_DIR" ] && [ ! -e /mnt/data/node_modules ]; then
    ln -s "$MODULE_DIR" /mnt/data/node_modules 2>/dev/null || true
fi
"${SCRIPT_DIR}/bun" run "$@"
EOF
                chmod +x "$BUN_DEST/run"

                {
                    echo "PATH=${BUN_DEST}:/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin:."
                    echo "NODE_PATH=${BUN_DEST}/node_modules"
                } > "$BUN_DEST/.env"

                BUN_INSTALLED=true
                echo "Bun ${BUN_VERSION} installed: $($BUN_DEST/bun --version)"
            else
                echo "ERROR: Failed to extract Bun archive"
                rm -rf bun.zip bun-linux-${BUN_ARCH}
                INSTALL_FAILED=true
            fi
        else
            echo "ERROR: Failed to download Bun"
            INSTALL_FAILED=true
        fi
    fi

    # ==============================
    # Install JavaScript packages for Bun
    # ==============================
    echo ""
    echo "=============================================="
    echo "  Installing Bun packages"
    echo "=============================================="
    echo ""

    if [ "$BUN_INSTALLED" = true ] && [ "${#JS_PACKAGES[@]}" -gt 0 ] && [ -f "$BUN_DEST/bun" ]; then
        cd "$BUN_DEST"
        BUN_BATCH_FAILED=false
        if ! BUN_PACKAGE_BATCH_SIZE="$(validate_bun_package_batch_size)"; then
            INSTALL_FAILED=true
        else
            BUN_BATCH_COUNT=$(( (${#JS_PACKAGES[@]} + BUN_PACKAGE_BATCH_SIZE - 1) / BUN_PACKAGE_BATCH_SIZE ))
            BUN_BATCH_INDEX=1

            for ((i = 0; i < ${#JS_PACKAGES[@]}; i += BUN_PACKAGE_BATCH_SIZE)); do
                echo "Installing Bun package batch ${BUN_BATCH_INDEX}/${BUN_BATCH_COUNT}"
                if ! BUN_CONFIG_MAX_HTTP_REQUESTS="${BUN_CONFIG_MAX_HTTP_REQUESTS:-8}" ./bun add --exact "${JS_PACKAGES[@]:i:BUN_PACKAGE_BATCH_SIZE}"; then
                    BUN_BATCH_FAILED=true
                    break
                fi
                BUN_BATCH_INDEX=$((BUN_BATCH_INDEX + 1))
            done

            if [ "$BUN_BATCH_FAILED" = true ]; then
                echo "ERROR: Bun package installation failed"
                INSTALL_FAILED=true
            else
                echo "$(date +%s)000" > "$BUN_DEST/.package-installed"
            fi
        fi

        echo ""
        echo "Installed Bun packages:"
        ./bun pm ls --depth 0 2>/dev/null | head -40 || true
    elif [ "$BUN_INSTALLED" = true ] && [ "${#JS_PACKAGES[@]}" -eq 0 ]; then
        echo "ERROR: No JavaScript packages loaded for Bun"
        INSTALL_FAILED=true
    elif [ "$BUN_INSTALLED" = true ]; then
        echo "ERROR: bun not found at $BUN_DEST/bun"
        INSTALL_FAILED=true
    else
        echo "Skipping Bun package installation because Bun was not installed"
    fi
fi

# ==============================
# Install Java
# ==============================
if ! language_selected java; then
    echo ""
    echo "Skipping Java (not in CODEAPI_LANGUAGES)"
elif java_ready; then
    echo ""
    echo "Java ${JAVA_VERSION} already installed, skipping"
else
    echo ""
    echo "=============================================="
    echo "  Installing Java ${JAVA_VERSION}"
    echo "=============================================="
    echo ""

    JAVA_DEST="/pkgs/java/${JAVA_VERSION}"
    mkdir -p "$JAVA_DEST"
    rm -f "$JAVA_DEST/.package-installed"
    JAVA_INSTALLED=false
    JAVA_FEATURE="${JAVA_VERSION%%.*}"

    ARCH=$(uname -m)
    case "$ARCH" in
        x86_64) JAVA_ARCH="x64" ;;
        aarch64|arm64) JAVA_ARCH="aarch64" ;;
        *)
            echo "ERROR: Unsupported architecture for Java: $ARCH"
            JAVA_ARCH=""
            INSTALL_FAILED=true
            ;;
    esac

    if [ -n "$JAVA_ARCH" ]; then
        JAVA_URL="https://github.com/adoptium/temurin${JAVA_FEATURE}-binaries/releases/download/jdk-${JAVA_VERSION}%2B${TEMURIN_BUILD}/OpenJDK${JAVA_FEATURE}U-jdk_${JAVA_ARCH}_linux_hotspot_${JAVA_VERSION}_${TEMURIN_BUILD}.tar.gz"
        cd /tmp
        if curl -fsSL "$JAVA_URL" -o java.tar.gz; then
            if tar -xzf java.tar.gz --strip-components=1 -C "$JAVA_DEST"; then
                rm -f java.tar.gz

                cat > "$JAVA_DEST/pkg-info.json" << EOF
{
    "language": "java",
    "version": "${JAVA_VERSION}",
    "build_platform": "docker-debian",
    "aliases": ["jdk", "openjdk", "temurin"]
}
EOF

                cat > "$JAVA_DEST/compile" << 'EOF'
#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The sandbox passes every submitted file; attachments like data.csv are
# inputs for the program, not compilation units.
SOURCES=()
for f in "$@"; do
    case "$f" in
        *.java) SOURCES+=("$f") ;;
    esac
done
exec "${SCRIPT_DIR}/bin/javac" "${SOURCES[@]}"
EOF
                chmod +x "$JAVA_DEST/compile"

                cat > "$JAVA_DEST/run" << 'EOF'
#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLASS="$(basename "${1%.java}")"
shift
exec "${SCRIPT_DIR}/bin/java" -XX:+UseSerialGC -cp . "$CLASS" "$@"
EOF
                chmod +x "$JAVA_DEST/run"

                {
                    echo "PATH=${JAVA_DEST}/bin:/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin:."
                    echo "JAVA_HOME=${JAVA_DEST}"
                } > "$JAVA_DEST/.env"

                JAVA_INSTALLED=true
                echo "$TEMURIN_BUILD" > "$JAVA_DEST/.temurin-build"
                echo "$(date +%s)000" > "$JAVA_DEST/.package-installed"
                echo "Java ${JAVA_VERSION} installed: $($JAVA_DEST/bin/java --version | head -1)"
            else
                echo "ERROR: Failed to extract Java archive"
                rm -f java.tar.gz
                INSTALL_FAILED=true
            fi
        else
            echo "ERROR: Failed to download Java from $JAVA_URL"
            INSTALL_FAILED=true
        fi
    fi
fi

# ==============================
# Register Bash
# ==============================
if ! language_selected bash; then
    echo ""
    echo "Skipping Bash (not in CODEAPI_LANGUAGES)"
elif bash_ready; then
    echo ""
    echo "Bash ${BASH_PACKAGE_VERSION} already registered, skipping"
else
    echo ""
    echo "=============================================="
    echo "  Registering Bash"
    echo "=============================================="
    echo ""

    SYSTEM_BASH_VERSION=$(bash --version | sed -nE '1s/.* ([0-9]+[.][0-9]+[.][0-9]+).*/\1/p')
    BASH_DEST="/pkgs/bash/${BASH_PACKAGE_VERSION}"
    mkdir -p "$BASH_DEST"

    cat > "$BASH_DEST/pkg-info.json" << EOF
{
    "language": "bash",
    "version": "${BASH_PACKAGE_VERSION}",
    "build_platform": "docker-debian",
    "system_version": "${SYSTEM_BASH_VERSION}",
    "aliases": ["sh"]
}
EOF

    cat > "$BASH_DEST/run" << 'EOF'
#!/bin/bash
bash "$@"
EOF
    chmod +x "$BASH_DEST/run"

    echo "PATH=/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin:." > "$BASH_DEST/.env"
    echo "$(date +%s)000" > "$BASH_DEST/.package-installed"

    echo "Bash ${BASH_PACKAGE_VERSION} registered (using system binary ${SYSTEM_BASH_VERSION})"
fi

# ==============================
# Finalize
# ==============================
echo ""
echo "=============================================="
echo "  Finalizing"
echo "=============================================="
echo ""

echo "Setting permissions..."
chmod -R a+rX /pkgs/ 2>/dev/null || true

if [ "$INSTALL_FAILED" = true ]; then
    echo ""
    echo "=============================================="
    echo "  ERROR: Package initialization FAILED"
    echo "=============================================="
    echo ""
    echo "One or more packages failed to install."
    echo "Marker file NOT created -- next run will retry."
    echo ""
    echo "Partial packages on disk:"
    ls -la /pkgs/
    echo ""
    exit 1
fi

echo "Creating initialization marker..."
cat > "$MARKER_FILE" << MARKER
initialized_at=$(date -Iseconds)
languages=${SELECTED_LANGUAGES_CSV}
python_version=${PYTHON_VERSION}
node_version=${NODE_VERSION}
bun_version=${BUN_VERSION}
java_version=${JAVA_VERSION}
packages=$(ls /pkgs/ 2>/dev/null | tr '\n' ',')
MARKER

echo ""
echo "=============================================="
echo "  Package initialization complete!"
echo "=============================================="
echo ""
echo "Installed packages:"
ls -la /pkgs/
echo ""
