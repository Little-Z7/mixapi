import type { CredentialSource } from './types';
import { decryptSecret } from './crypto';

export class StaticKeyCredential implements CredentialSource {
  constructor(private secretEnc: Uint8Array, private masterKeyHex: string) {}
  async getApiKey(): Promise<string> {
    return decryptSecret(this.secretEnc, this.masterKeyHex);
  }
}
