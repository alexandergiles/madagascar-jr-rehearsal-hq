"""
Encrypt media + script text so the public GitHub Pages site is passkey-gated.

Reads plaintext files from media/*.mp3, media/script.pdf, and script_text.json.
Writes AES-256-GCM ciphertext (.enc) alongside a crypto_meta.json (salt +
PBKDF2 iterations) and a verifier.enc used by the client to validate the
passkey before attempting to decrypt any content.

Usage:
    PASSKEY=your_passkey python3 encrypt_media.py
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
MEDIA = ROOT / "media"
ITERS = 200_000
VERIFIER_PLAINTEXT = b"MADAGASCAR-OK"


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
    aes = AESGCM(key)
    iv = secrets.token_bytes(12)
    return iv + aes.encrypt(iv, data, None)


def main():
    passkey = os.environ.get("PASSKEY")
    if not passkey:
        print("Set PASSKEY env var (e.g. PASSKEY=lions123 python3 encrypt_media.py)", file=sys.stderr)
        sys.exit(1)

    salt = secrets.token_bytes(16)
    key = derive_key(passkey.encode("utf-8"), salt)

    (ROOT / "crypto_meta.json").write_text(
        json.dumps(
            {
                "salt_b64": base64.b64encode(salt).decode(),
                "iters": ITERS,
                "verifier_plaintext": VERIFIER_PLAINTEXT.decode(),
            },
            indent=2,
        )
    )

    (ROOT / "verifier.enc").write_bytes(encrypt_bytes(key, VERIFIER_PLAINTEXT))
    print("  ✓ verifier.enc")

    for f in sorted(MEDIA.glob("*")):
        if f.suffix == ".enc" or not f.is_file():
            continue
        dst = MEDIA / (f.name + ".enc")
        dst.write_bytes(encrypt_bytes(key, f.read_bytes()))
        print(f"  ✓ media/{f.name} -> media/{dst.name}")

    stext = ROOT / "script_text.json"
    if stext.exists():
        (ROOT / "script_text.json.enc").write_bytes(encrypt_bytes(key, stext.read_bytes()))
        print("  ✓ script_text.json -> script_text.json.enc")

    print(f"\nPasskey OK. Salt: {base64.b64encode(salt).decode()}  Iters: {ITERS}")


if __name__ == "__main__":
    main()
