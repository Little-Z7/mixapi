export interface CredentialSource {
  getApiKey(): Promise<string>;
}
