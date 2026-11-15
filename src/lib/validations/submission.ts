import { z } from "zod";

const httpUrl = z
    .string()
    .trim()
    .min(1, "Link is required")
    .max(2048, "Link is too long")
    .refine((value) => {
        try {
            const url = new URL(value);
            return url.protocol === "http:" || url.protocol === "https:";
        } catch {
            return false;
        }
    }, "Link must be a valid http(s) URL");

export const submissionSchema = z.object({
    techname: z.string().trim().min(1, "Tool name is required").max(160),
    link: httpUrl,
    displaytext: z.string().trim().min(1, "Display text is required").max(200),
    tl1_desc: z.string().max(8000).optional().default(""),
    tl2_desc: z.string().max(8000).optional().default(""),
    tl3_desc: z.string().max(8000).optional().default(""),
    tl4_desc: z.string().max(8000).optional().default(""),
    username: z.string().max(120).optional().default(""),
    contact: z.string().max(200).optional().default(""),
    // Domain checkboxes - these will come as string "true" or undefined
    R: z.string().optional(),
    TP: z.string().optional(),
    MT: z.string().optional(),
    AR: z.string().optional(),
    U: z.string().optional(),
    MDL: z.string().optional(),
    RA: z.string().optional(),
    RoTech: z.string().optional(),
    LS: z.string().optional(),
    RoThink: z.string().optional(),
    EoST: z.string().optional(),
    EF: z.string().optional(),
    RTE: z.string().optional(),
    DLoI: z.string().optional(),
    RaAoC: z.string().optional(),
});

export type SubmissionInput = z.infer<typeof submissionSchema>;
