import { resolve } from "path";
import { afterAll, setDefaultTimeout } from "bun:test";
import { CONFORMITY_TEST_BUDGET_MS, runScaffoldConformity, runSpecDiscovery, runSpecDrift, runDocHygiene, runFallowCheck, runAgentFileValidation, runDirectoryValidation, runPackageValidation, runTsconfigValidation, runConfigAccessValidation, runPromptConfigAccessValidation, runSuccessDocValidation, runAiReviewValidation, runBranchProtectionValidation, runWorkflowDriftValidation, runInstructionSurfaceValidation, writeFindingsReport } from "../lib/conformity";

const ROOT = resolve(import.meta.dir, "..");

setDefaultTimeout(CONFORMITY_TEST_BUDGET_MS);

runScaffoldConformity(ROOT);
runSpecDiscovery(ROOT);
runSpecDrift(ROOT);
runDocHygiene(ROOT);
runFallowCheck(ROOT);
runAgentFileValidation(ROOT);
runDirectoryValidation(ROOT);
runPackageValidation(ROOT);
runTsconfigValidation(ROOT);
runConfigAccessValidation(ROOT);
runPromptConfigAccessValidation(ROOT);
runSuccessDocValidation(ROOT);
runAiReviewValidation(ROOT);
runBranchProtectionValidation(ROOT);
runWorkflowDriftValidation(ROOT);
runInstructionSurfaceValidation(ROOT);

afterAll(() => writeFindingsReport(ROOT));
