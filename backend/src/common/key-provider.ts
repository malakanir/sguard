/** Sumber kunci enkripsi kredensial. Memungkinkan rotasi tanpa mengubah pemanggil `CryptoService`. */
export interface KeyProvider {
  activeKeyId(): string;
  getKey(keyId: string): Buffer;
  listKeyIds(): string[];
  isConfigured(): boolean;
}

export const KEY_PROVIDER = Symbol('KEY_PROVIDER');
