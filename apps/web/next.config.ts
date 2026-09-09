import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@hanja/contracts", "@hanja/stroke-engine"],
  async headers() {
    return [
      {
        source: "/media/dokkaebi-game-intro-v1.mp4",
        headers: [
          { key: "Cache-Control", value: "public, max-age=31536000, immutable" },
        ],
      },
      {
        source: "/media/dokkaebi-game-intro-mobile-v1.mp4",
        headers: [
          { key: "Cache-Control", value: "public, max-age=31536000, immutable" },
        ],
      },
    ];
  },
};

export default nextConfig;
