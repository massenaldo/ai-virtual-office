/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Empty = browser mock (default). An http(s) origin selects the local backend. */
  readonly VITE_WORKFORCE_API_URL?: string
}
