import { Job } from "bullmq";
import { WorkerHost } from "@nestjs/bullmq";
import { AdminCallQueues } from "../enums/AdminCallQueues";
import { UseQueue } from "../../utilities/QueueProcessors";
import { AdminCallService } from "../admin-call.service";

// Durable counterpart to the ring's in-memory expectation: a plain
// setTimeout inside AdminCallService.ring would be lost if the pod
// restarts mid-ring (this API redeploys often), leaving the admin's
// "Calling..." screen stuck forever with nothing to ever resolve it.
// A delayed BullMQ job survives that restart and still fires.
@UseQueue("AdminCalls", AdminCallQueues.RingTimeout)
export class TimeoutAdminCallRing extends WorkerHost {
  constructor(private readonly adminCall: AdminCallService) {
    super();
  }

  async process(job: Job<{ targetSteamId: string }>): Promise<void> {
    await this.adminCall.timeoutRingIfUnanswered(job.data.targetSteamId);
  }
}
