import { Worker } from "bullmq";
interface KybMockCompletionJob {
    institutionId: string;
    diditSessionId: string;
    institutionName: string;
}
export declare function startKybMockWorker(): Promise<Worker<KybMockCompletionJob, any, string>>;
export {};
//# sourceMappingURL=kyb-mock-completion.d.ts.map