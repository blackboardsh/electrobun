/// <reference types="vite/client" />

declare module "*.css" {
  const content: string
  export default content
}

declare module "*.css?used" {
  const content: string
  export default content
}
