export declare class RangeService {
    /**
     * STUBBED: Screen an institution's details against Range.org AML/Sanctions lists
     */
    performDeepScreening(institutionName: string, country: string): Promise<{
        status: "clear" | "flagged" | "rejected";
        reportId: string;
    }>;
}
export declare const rangeService: RangeService;
//# sourceMappingURL=range.d.ts.map