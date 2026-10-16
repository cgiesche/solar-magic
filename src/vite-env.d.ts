/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** commit the build was made from (Docker build arg COMMIT), unset in dev builds */
  readonly VITE_COMMIT?: string;
  /** version of the build (tools/version.ts, e.g. 0.1.232), unset in dev builds */
  readonly VITE_VERSION?: string;
}
