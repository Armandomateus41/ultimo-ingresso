import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Build enxuto para a imagem Docker (servidor Node com só o necessário).
  output: "standalone",
  devIndicators: false,
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    // A pasta acima tem outro package-lock.json: fixa a raiz neste projeto.
    root: __dirname,
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
