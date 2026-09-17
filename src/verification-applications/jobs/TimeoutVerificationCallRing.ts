import { Job } from "bullmq";
import { WorkerHost } from "@nestjs/bullmq";
import { VerificationCallQueues } from "../enums/VerificationCallQueues";
import { UseQueue } from "../../utilities/QueueProcessors";
import { VerificationCallService } from "../verification-call.service";

// Durable counterpart to the ring's in-memory expectation: a plain
// setTimeout inside VerificationCallService.ring would be lost if the
// pod restarts mid-ring (this API redeploys often), leaving the admin's
// "Calling..." screen stuck forever with nothing to ever resolve it.
// A delayed BullMQ job survives that restart and still fires.
@UseQueue("VerificationCalls", VerificationCallQueues.RingTimeout)
export class TimeoutVerificationCallRing extends WorkerHost {
  constructor(private readonly verificationCall: VerificationCallService) {
    super();
  }

  async process(job: Job<{ applicationId: string }>): Promise<void> {
    await this.verificationCall.timeoutRingIfUnanswered(job.data.applicationId);
  }
}
