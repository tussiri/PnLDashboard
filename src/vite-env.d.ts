/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** "true" lets a production build offer the browser-only demo sign-in when no API answers. Never set on Render. */
  readonly VITE_DEMO_SIGN_IN?: string
}
