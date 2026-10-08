/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** commit the build was made from (Docker build arg COMMIT), unset in dev builds */
  readonly VITE_COMMIT?: string;
}
