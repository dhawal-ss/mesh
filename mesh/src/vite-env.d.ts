/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_MESH_HOMESERVER?: string
  readonly VITE_MESH_SERVICE_NAME?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
