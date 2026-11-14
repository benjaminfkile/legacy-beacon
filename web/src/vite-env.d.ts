/// <reference types="vite/client" />

declare module "*.module.css" {
  const classes: Record<string, string> & { [key: string]: string };
  export default classes;
}

declare module "*.css";
