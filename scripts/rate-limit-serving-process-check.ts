import { readRateLimitTelemetryServingProcessProof } from "../src/infra/rate-limit-observability";

const proof = await readRateLimitTelemetryServingProcessProof();
if (proof === null) {
	throw new Error("serving process liveness proof unavailable");
}
console.log(proof);
