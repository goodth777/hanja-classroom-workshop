import { expect, it } from "vitest";
import { supabaseServiceHeaders } from "./supabase-headers.js";
it("uses new secret API keys only as apikey, and preserves legacy JWT authentication", () => {
  expect(supabaseServiceHeaders(" sb_secret_example ")).toEqual({ apikey: "sb_secret_example", "content-type": "application/json" });
  expect(supabaseServiceHeaders("eyJ.example.signature")).toMatchObject({ apikey: "eyJ.example.signature", authorization: "Bearer eyJ.example.signature" });
});
