import { test, expect, describe } from "bun:test";
import { findStatementEnd } from "./node-server.ts";

describe("findStatementEnd", () => {
  test("ends at a semicolon on the same line", () => {
    const src = `const app = express();\napp.listen(3000);`;
    const end = findStatementEnd(src, 0);
    expect(src.slice(0, end)).toBe("const app = express();");
  });

  test("ends at a newline when there is no semicolon", () => {
    const src = `const app = express()\napp.listen(3000)`;
    const end = findStatementEnd(src, 0);
    expect(src.slice(0, end)).toBe("const app = express()");
  });

  test("spans a multi-line options object", () => {
    const src = `const fastify = Fastify({\n  logger: true,\n});\nnext();`;
    const end = findStatementEnd(src, 0);
    expect(src.slice(0, end)).toBe("const fastify = Fastify({\n  logger: true,\n});");
  });

  test("continues through a chained call on the next line", () => {
    const src = `const app = Fastify({})\n  .withTypeProvider();\nnext();`;
    const end = findStatementEnd(src, 0);
    expect(src.slice(0, end)).toBe("const app = Fastify({})\n  .withTypeProvider();");
  });

  test("ignores brackets inside string literals", () => {
    const src = `const app = express();\nconsole.log("(unbalanced");`;
    const end = findStatementEnd(src, 0);
    expect(src.slice(0, end)).toBe("const app = express();");
  });

  test("ignores brackets inside template literals", () => {
    const src = "const x = f(`open ( paren`);\nnext();";
    const end = findStatementEnd(src, 0);
    expect(src.slice(0, end)).toBe("const x = f(`open ( paren`);");
  });

  test("returns content length for an unterminated statement", () => {
    const src = `const app = express(`;
    expect(findStatementEnd(src, 0)).toBe(src.length);
  });
});
