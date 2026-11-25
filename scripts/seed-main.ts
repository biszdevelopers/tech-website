import "./load-env";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import bcrypt from "bcryptjs";
import { mainDb, mainSqlite } from "../src/lib/db/main";
import { createToolBundle } from "../src/server/queries/submissions";
import { parseResourceLines, type ResourceInput } from "../src/lib/resources";
import { normalizeCategories } from "../src/lib/categories";
import { strandColumnNames } from "../src/lib/tl-config";

interface ParsedTool {
    techname: string;
    tl1_desc: string;
    tl2_desc: string;
    tl3_desc: string;
    tl4_desc: string;
    tl5_desc: string;
    tl6_desc: string;
    tl5_tags: string;
    tl6_tags: string;
    link: string;
    displaytext: string;
    accepted: boolean;
    domains: Record<string, boolean>;
    resources: ResourceInput[];
}

const DOMAIN_FIELDS = strandColumnNames();

const TL56_SEED: Record<string, { tl5: string; tl6: string; tl5Tags: string; tl6Tags: string }> = {
    TEAMS: {
        tl5: "Use Teams channels and shared files for collaborative planning, peer feedback and professional learning across the school.",
        tl6: "Use Teams chat and meetings to keep communication respectful and inclusive, share resources with colleagues and follow up promptly.",
        tl5Tags: "Growth goals, Professional development",
        tl6Tags: "Professional responsibilities, Communication, Collegiality",
    },
    WEEBLY: {
        tl5: "Publish a professional portfolio or class site, then use feedback and reflection to refine the resources shared with colleagues.",
        tl6: "",
        tl5Tags: "Self-reflection, Professional development",
        tl6Tags: "",
    },
    NEARPOD: {
        tl5: "Adapt ready-made Nearpod lessons and share what works in department meetings, using student response data to guide professional learning.",
        tl6: "",
        tl5Tags: "Professional development, Adaptability",
        tl6Tags: "",
    },
    PADLET: {
        tl5: "",
        tl6: "Open a shared staff Padlet for celebrations, questions and ideas so every colleague has an easy, respectful way to contribute.",
        tl5Tags: "",
        tl6Tags: "Communication, Collegiality",
    },
    SEESAW: {
        tl5: "",
        tl6: "Use Seesaw family communication tools to share positive updates and keep families included in the classroom community.",
        tl5Tags: "",
        tl6Tags: "Communication, Collegiality",
    },
    "CLASS DOJO": {
        tl5: "",
        tl6: "Use Class Dojo points and parent updates to reinforce positive behavior and build a consistent, supportive classroom culture.",
        tl5Tags: "",
        tl6Tags: "Communication, Collegiality",
    },
};

const SEED_RESOURCES: Record<string, ResourceInput[]> = {
    PADLET: [
        { label: "Manual", url: "https://teachers.tech/how-to-use-padlet/" },
        { label: "Video", url: "https://www.youtube.com/watch?v=OPkq5q8nRbM" },
    ],
    SEESAW: [
        { label: "Getting started", url: "https://files.seesaw.me/getting_started/v2/general.pdf" },
        { label: "Video tutorial", url: "https://www.youtube.com/watch?v=ihW5xdEnOi0" },
    ],
    TEAMS: [
        {
            label: "Create a meeting",
            url: "https://support.microsoft.com/en-us/topic/creating-attending-and-running-meetings-while-using-teams-for-distance-learning-788d730b-0a3d-4b29-8e4b-72db7a6a3c7c",
        },
    ],
};

function bool(value: string | undefined): boolean {
    const v = String(value ?? "")
        .trim()
        .toLowerCase();
    return v === "1" || v === "true" || v === "yes" || v === "y";
}

function parseSection(block: string): ParsedTool[] {
    const lines = block
        .split(/\r?\n/)
        .map((line) => line.replace(/\r$/, ""))
        .filter((line) => line.trim() !== "");
    const headerIndex = lines.findIndex((line) => /^techname\t/i.test(line));
    if (headerIndex === -1) return [];
    const header = lines[headerIndex].split("\t").map((cell) => cell.trim());
    const columns = new Map<string, number>();
    header.forEach((cell, index) => {
        columns.set(cell.toLowerCase().replace(/\s+/g, "_"), index);
    });
    const read = (cells: string[], name: string): string => {
        const index = columns.get(name);
        return index === undefined ? "" : String(cells[index] ?? "").trim();
    };
    const out: ParsedTool[] = [];
    for (const line of lines.slice(headerIndex + 1)) {
        const cells = line.split("\t");
        const techname = read(cells, "techname");
        if (!techname || techname.toLowerCase() === "techname") continue;
        const domains: Record<string, boolean> = {};
        for (const field of DOMAIN_FIELDS) {
            domains[field] = bool(read(cells, field.toLowerCase()));
        }
        const resourcesText = read(cells, "resources");
        const parsedResources = resourcesText
            ? parseResourceLines(resourcesText)
            : { ok: true, rows: [] };
        const curated = TL56_SEED[techname.toUpperCase()];
        out.push({
            techname,
            tl1_desc: read(cells, "tl1_description") || read(cells, "tl1"),
            tl2_desc: read(cells, "tl2_description") || read(cells, "tl2"),
            tl3_desc: read(cells, "tl3_description") || read(cells, "tl3"),
            tl4_desc: read(cells, "tl4_description") || read(cells, "tl4"),
            tl5_desc: read(cells, "tl5_description") || curated?.tl5 || "",
            tl6_desc: read(cells, "tl6_description") || curated?.tl6 || "",
            tl5_tags: normalizeCategories(
                read(cells, "tl5_categories") || read(cells, "tl5_tags") || curated?.tl5Tags || "",
                "tl5"
            ),
            tl6_tags: normalizeCategories(
                read(cells, "tl6_categories") || read(cells, "tl6_tags") || curated?.tl6Tags || "",
                "tl6"
            ),
            link: read(cells, "link"),
            displaytext: read(cells, "displaytext") || techname,
            accepted: bool(read(cells, "accepted")),
            domains,
            resources: parsedResources.ok
                ? parsedResources.rows.length
                    ? parsedResources.rows
                    : (SEED_RESOURCES[techname.toUpperCase()] ?? [])
                : [],
        });
    }
    return out;
}

function loadTools(): ParsedTool[] {
    const raw = readFileSync(resolve(process.cwd(), "tools.txt"), "utf8");
    const blocks: string[] = [];
    let current: string[] = [];
    for (const line of raw.split("\n")) {
        if (/^tools\d/i.test(line.trim())) {
            if (current.length > 0) blocks.push(current.join("\n"));
            current = [line];
        } else if (current.length > 0) {
            current.push(line);
        }
    }
    if (current.length > 0) blocks.push(current.join("\n"));
    const byName = new Map<string, ParsedTool>();
    for (const block of blocks) {
        for (const tool of parseSection(block)) byName.set(tool.techname, tool);
    }
    return Array.from(byName.values());
}

async function main(): Promise<void> {
    console.log("Seeding main database...");

    const existingLogin = await mainDb.login.findFirst();
    if (!existingLogin) {
        await mainDb.login.create({
            data: { User: "admin", PW: await bcrypt.hash("admin12345", 12), sessionVersion: 0 },
        });
        console.log("  demo operator created (admin / admin12345)");
    } else if (existingLogin.sessionVersion === undefined) {
        await mainDb.login.update({
            where: { User: existingLogin.User },
            data: { sessionVersion: 0 },
        });
    } else {
        console.log("  operator login exists, left untouched");
    }

    const count = await mainDb.submission.count();
    if (count > 0) {
        console.log("  existing submissions found; tool seed skipped to protect live data");
        console.log("  use pnpm run db:reset for a clean demo database");
        await mainDb.$disconnect();
        return;
    }

    const tools = loadTools();
    console.log(`  parsed ${tools.length} tools from tools.txt`);
    if (tools.length === 0) {
        console.log("  no tool sections found; nothing was deleted");
        await mainDb.$disconnect();
        return;
    }

    for (let index = 0; index < tools.length; index += 1) {
        const tool = tools[index];
        const id = index + 1;
        createToolBundle(
            {
                id,
                techname: tool.techname,
                link: tool.link,
                displaytext: tool.displaytext,
                tl1_desc: tool.tl1_desc,
                tl2_desc: tool.tl2_desc,
                tl3_desc: tool.tl3_desc,
                tl4_desc: tool.tl4_desc,
                tl5_desc: tool.tl5_desc,
                tl6_desc: tool.tl6_desc,
                tl5_tags: tool.tl5_tags,
                tl6_tags: tool.tl6_tags,
                username: "seed",
                contact: "seed@bibs-c.local",
                accepted: tool.accepted,
            },
            tool.domains as never,
            tool.resources
        );
    }

    mainSqlite
        .prepare(
            "INSERT INTO app_meta (key, value) VALUES ('nextSubmissionId', ?) " +
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
        )
        .run(String(tools.length + 1));

    console.log(`  ${tools.length} submissions, domain rows and resources populated`);
    console.log("Main database seeded successfully.");
    await mainDb.$disconnect();
}

main().catch((error) => {
    console.error("Seed error:", error);
    process.exit(1);
});
