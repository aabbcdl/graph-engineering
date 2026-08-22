import assert from "node:assert/strict";
import test from "node:test";

import { isRepositoryFinding } from "../adapters/common.mjs";

test("Graph evaluation excludes runner-control lineage but keeps repository findings", () => {
  assert.equal(
    isRepositoryFinding({
      observations: [
        { id: "RUNNER-EVIDENCE-GAP", node: "verification-r0" },
        { id: "RUNNER-EVIDENCE-GAP", node: "correction-r1" },
      ],
    }),
    false,
  );
  assert.equal(
    isRepositoryFinding({
      observations: [
        { id: "RUNNER-EVIDENCE-GAP", node: "verification-r0" },
        { id: "REV-007", node: "independent-review-r2" },
      ],
    }),
    true,
  );
  assert.equal(isRepositoryFinding({ observations: [] }), true);
});
