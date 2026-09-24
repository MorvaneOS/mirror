#!/usr/bin/env bash
# Adds packages to the [morvane] repository in R2.
# Usage: bash publish.sh path/to/foo-1.0-1-any.pkg.tar.zst [...]
set -euo pipefail

REPO_NAME=morvane
ARCH=x86_64
BUCKET=morvane-repo
URL=https://morvane.doughmination.gay
PREFIX="$REPO_NAME/os/$ARCH"
export CLOUDFLARE_ACCOUNT_ID=f87ee4b9600f437b8da1104d077418c3

(( $# )) || { echo "Usage: bash publish.sh <package files...>" >&2; exit 1; }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# Start from the live database so repo-add appends to it. Only a 404 means
# "no repo yet"; any other failure aborts, since starting fresh would drop every
# package already published.
for db in "$REPO_NAME.db.tar.gz" "$REPO_NAME.files.tar.gz"; do
    code=$(curl -sS -o "$work/$db" -w '%{http_code}' "$URL/$PREFIX/$db")
    case "$code" in
        200) ;;
        404) rm -f "$work/$db"; echo "No $db yet; creating a new repository" ;;
        *) echo "Fetching $db failed (HTTP $code); aborting" >&2; exit 1 ;;
    esac
done

pkgs=()
for pkg in "$@"; do
    cp "$pkg" "$work/"
    pkgs+=("$(basename "$pkg")")
done

# repo-add ships with pacman; outside Arch (e.g. WSL Ubuntu) borrow it from the Artix image
if command -v repo-add >/dev/null; then
    (cd "$work" && repo-add "$REPO_NAME.db.tar.gz" "${pkgs[@]}")
else
    docker run --rm -v "$work":/work -w /work artixlinux/artixlinux:latest \
        repo-add "$REPO_NAME.db.tar.gz" "${pkgs[@]}"
fi

put() {
    wrangler r2 object put "$BUCKET/$PREFIX/$2" --file "$work/$1" --content-type application/octet-stream --remote
}

# Packages first, so the database never lists a file that isn't there yet
for pkg in "${pkgs[@]}"; do
    put "$pkg" "$pkg"
done

# pacman downloads morvane.db, which repo-add makes as a symlink. R2 has no
# symlinks, so upload the real file under both names.
for db in db files; do
    put "$REPO_NAME.$db.tar.gz" "$REPO_NAME.$db.tar.gz"
    put "$REPO_NAME.$db.tar.gz" "$REPO_NAME.$db"
done

echo "Published: ${pkgs[*]}"
