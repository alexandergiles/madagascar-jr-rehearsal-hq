"""
Encrypt a GitHub PAT with a separate editor passkey.

Writes:
  - pat.enc               (AES-GCM ciphertext of the PAT)
  - crypto_meta.json      (augmented with editor_salt_b64 + editor_iters)

Both editors then share the EDITOR_PASSKEY (not the PAT itself); the browser
fetches pat.enc, derives the key from the editor passkey via PBKDF2, and
decrypts the PAT for use with the GitHub Contents API.

Usage:
    EDITOR_PASSKEY=chooseSomethingStrong PAT=github_pat_... python3 encrypt_pat.py

Rotation: revoke the old PAT on GitHub, generate a new one, re-run this
script (bumping EDITOR_PASSKEY if you also want to lock previous editors out).
"""

import base64
import json
import os
import secrets
import sys
from pathlib import Path

from cryptography.hazmat.backends import default_backend
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

ROOT = Path(__file__).parent
META = ROOT / "crypto_meta.json"
PAT_ENC = ROOT / "pat.enc"
ITERS = 200_000


def derive_key(password: bytes, salt: bytes) -> bytes:
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=32,
        salt=salt,
        iterations=ITERS,
        backend=default_backend(),
    )
    return kdf.derive(password)


def encrypt_bytes(key: bytes, data: bytes) -> bytes:
    iv = secrets.token_bytes(12)
    return iv + AESGCM(key).encrypt(iv, data, None)


def main():
    passkey = os.environ.get("EDITOR_PASSKEY")
    pat = os.environ.get("PAT")
    if not passkey or not pat:
        print(
            "Set EDITOR_PASSKEY and PAT env vars, e.g.\n"
            "  EDITOR_PASSKEY=xyz PAT=github_pat_... python3 encrypt_pat.py",
            file=sys.stderr,
        )
        sys.exit(1)

    if not META.exists():
        print("crypto_meta.json not found — run encrypt_media.py first.", file=sys.stderr)
        sys.exit(1)

    meta = json.loads(META.read_text())

    # Rotate the editor salt each run so that revoked PATs can't be re-decrypted.
    salt = secrets.token_bytes(16)
    key = derive_key(passkey.encode("utf-8"), salt)

    PAT_ENC.write_bytes(encrypt_bytes(key, pat.encode("utf-8")))
    print(f"  ✓ pat.enc ({len(pat)} chars -> {PAT_ENC.stat().st_size} bytes)")

    meta["editor_salt_b64"] = base64.b64encode(salt).decode()
    meta["editor_iters"] = ITERS
    META.write_text(json.dumps(meta, indent=2))
    print("  ✓ crypto_meta.json updated with editor_salt_b64 / editor_iters")

    print(
        "\nDone. Commit pat.enc + crypto_meta.json to publish. "
        "Share the EDITOR_PASSKEY with your co-editor (never the PAT)."
    )


if __name__ == "__main__":
    main()
