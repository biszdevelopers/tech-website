import { z } from "zod";

export const webRegisterSchema = z
    .object({
        username: z
            .string()
            .min(3, "Username must be at least 3 characters")
            .max(20)
            .regex(
                /^[a-zA-Z0-9_.-]+$/,
                "Username may only contain letters, numbers, dot, dash and underscore"
            ),
        password: z.string().min(10, "Password must be at least 10 characters").max(200),
        confirmPassword: z.string(),
    })
    .refine(
        (data: { username: string; password: string; confirmPassword: string }) =>
            data.password === data.confirmPassword,
        {
            message: "Passwords do not match",
            path: ["confirmPassword"],
        }
    );

export const webLoginSchema = z.object({
    username: z.string().min(1, "Username is required"),
    password: z.string().min(1, "Password is required"),
});
