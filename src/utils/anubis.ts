import crypto from 'crypto';

/**
 * Solves Anubis v1.25.0 Proof-of-Work challenge.
 * Difficulty is measured in leading zero BITS (not hex chars).
 *
 * @param randomData - The random challenge string from the anti-bot page
 * @param difficulty - Number of leading zero bits required (typically 3-5)
 * @param maxAttempts - Safety limit (default 500000)
 * @returns { nonce, hash } or throws if maxAttempts exceeded
 */
export async function solveAnubisPoW(
  randomData: string,
  difficulty: number,
  maxAttempts = 500_000,
): Promise<{ nonce: number; hash: string }> {
  const zeroBytes = Math.floor(difficulty / 2);
  const nibbleCheck = difficulty % 2 !== 0;
  let nonce = 0;

  while (nonce < maxAttempts) {
    const hash = crypto
      .createHash('sha256')
      .update(randomData + nonce)
      .digest();
    const bytes = new Uint8Array(
      hash.buffer,
      hash.byteOffset,
      hash.byteLength,
    );

    let valid = true;
    for (let i = 0; i < zeroBytes && valid; i++) {
      if (bytes[i] !== 0) valid = false;
    }

    if (valid && nibbleCheck && (bytes[zeroBytes] & 0xf0) !== 0) {
      valid = false;
    }

    if (valid) {
      const hex = Array.from(bytes)
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
      return { nonce, hash: hex };
    }

    nonce++;
  }

  throw new Error(
    `Anubis PoW: exceeded ${maxAttempts} attempts for difficulty ${difficulty}`,
  );
}

/**
 * Solve synchronously (blocking). Use only if async overhead is unacceptable.
 */
export function solveAnubisPoWSync(
  randomData: string,
  difficulty: number,
  maxAttempts = 500_000,
): { nonce: number; hash: string } {
  const zeroBytes = Math.floor(difficulty / 2);
  const nibbleCheck = difficulty % 2 !== 0;
  let nonce = 0;

  while (nonce < maxAttempts) {
    const hash = crypto
      .createHash('sha256')
      .update(randomData + nonce)
      .digest();
    const bytes = new Uint8Array(
      hash.buffer,
      hash.byteOffset,
      hash.byteLength,
    );

    let valid = true;
    for (let i = 0; i < zeroBytes && valid; i++) {
      if (bytes[i] !== 0) valid = false;
    }

    if (valid && nibbleCheck && (bytes[zeroBytes] & 0xf0) !== 0) {
      valid = false;
    }

    if (valid) {
      const hex = Array.from(bytes)
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
      return { nonce, hash: hex };
    }

    nonce++;
  }

  throw new Error(
    `Anubis PoW: exceeded ${maxAttempts} attempts for difficulty ${difficulty}`,
  );
}

/**
 * Extract clean cookie value from Set-Cookie header.
 */
export function parseSetCookie(setCookie: string): string {
  if (!setCookie) return '';
  const semi = setCookie.indexOf(';');
  return semi > 0
    ? setCookie.substring(0, semi).trim()
    : setCookie.trim();
}
