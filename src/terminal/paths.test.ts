import path from "node:path";
import { describe, expect, it } from "vitest";
import { compactHomePath } from "./paths.ts";

const root = path.parse(process.cwd()).root;
const home = path.join(root, "Users", "alex");

describe("terminal path display", () => {
  it("compacts absolute paths inside the home directory", () => {
    expect(compactHomePath(path.join(home, "Code", "work"), home)).toBe(
      path.join("~", "Code", "work"),
    );
    expect(compactHomePath(home, home)).toBe("~");
  });

  it("leaves non-home and relative paths unchanged", () => {
    expect(compactHomePath(path.join(root, "tmp", "work"), home)).toBe(
      path.join(root, "tmp", "work"),
    );
    expect(compactHomePath(path.join("Code", "work"), home)).toBe(
      path.join("Code", "work"),
    );
  });
});
