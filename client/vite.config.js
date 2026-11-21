import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { PRODUCT_NAME } from "./src/product.js";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    {
      name: "product-metadata",
      transformIndexHtml: (html) =>
        html.replaceAll("__PRODUCT_NAME__", PRODUCT_NAME),
    },
  ],
});
