import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Without this, a second render finds the first one still mounted and every
// `getBy*` throws on multiple matches.
afterEach(cleanup);
