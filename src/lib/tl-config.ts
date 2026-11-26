export interface StrandConfig {
    checkboxName: string;
    label: string;
    tooltip: string;
    domainColumn: string;
    cssClass: string;
    slug: string;
}

export interface TLConfig {
    id: string;
    title: string;
    shortLabel: string;
    navLabel: string;
    description: string;
    standards: string[];
    topics: string[];
    strands: StrandConfig[];
}

export const tlConfigs: Record<string, TLConfig> = {
    tl1: {
        id: "tl1",
        title: "TL1: Knowing Our Students",
        shortLabel: "Knowing",
        navLabel: "Knowing (TL1)",
        description:
            "Build respectful relationships, clear routines and personalized support so every student can participate successfully.",
        standards: [
            "Establishes a respectful and inclusive classroom atmosphere, evident in positive student interactions and a culture of mutual respect.",
            "Implements clear routines and shared expectations, creating a visibly safe and orderly learning environment.",
            "Demonstrates cultural awareness by incorporating materials and practices that recognize and value the backgrounds of our students.",
            "Applies adaptable classroom management techniques, responding effectively to student behavior and maintaining a learning-focused environment.",
            "Encourages active student engagement, using motivational strategies that encourage participation, positive social interactions, and self-motivation.",
            "Tailors learning experiences to support each student's intellectual personal growth, as seen through differentiated instruction and personalized support.",
        ],
        topics: ["Relationships", "Teacher planning", "Modify their teaching", "Achieve readiness"],
        strands: [
            {
                checkboxName: "s1",
                label: "Relationships",
                tooltip: "Teacher/student relationships are proactive and positive.",
                domainColumn: "R",
                cssClass: "n1",
                slug: "relationships",
            },
            {
                checkboxName: "s2",
                label: "Teacher Planning",
                tooltip:
                    "Teacher planning is driven by knowledge of each student's next steps for learning.",
                domainColumn: "TP",
                cssClass: "n2",
                slug: "teacher-planning",
            },
            {
                checkboxName: "s3",
                label: "Modify their Teaching",
                tooltip: "Teachers modify their teaching based on what students need to succeed.",
                domainColumn: "MT",
                cssClass: "n3",
                slug: "modify-their-teaching",
            },
            {
                checkboxName: "s4",
                label: "Achieve Readiness",
                tooltip:
                    "Teachers achieve readiness for learning by constructing tasks or offering learning choices at different levels of complexity.",
                domainColumn: "AR",
                cssClass: "n4",
                slug: "achieve-readiness",
            },
        ],
    },
    tl2: {
        id: "tl2",
        title: "TL2: Strategies for Learning",
        shortLabel: "Strategies",
        navLabel: "Strategies (TL2)",
        description:
            "Design learning experiences that make subject matter relevant and help students think, collaborate and perform.",
        standards: [
            "Demonstrates comprehensive knowledge and understanding of the subject matter taught.",
            "Identifies and communicates the central concepts, structures, and tools of inquiry of the discipline or disciplines.",
            "Creates learning experiences that make the subject matter relevant, using real-world examples and connections that captivate students' interest.",
            "Incorporates a variety of instructional strategies and resources to encourage students' critical thinking, problem solving, and performance skills.",
            "Uses appropriate engagement strategies, pacing, sequencing, protocols, purposeful questioning, and resources.",
            "Facilitates peer interactions and collaborative learning, promoting discussions that deepen understanding and build academic skills.",
            "Integrates technology thoughtfully, using digital tools to enhance learning and provide interactive experiences aligned with lesson objectives.",
        ],
        topics: [
            "Understanding",
            "Multi-dimensional learning",
            "Reasoned arguments",
            "Repertoire of techniques",
            "Learning spaces",
        ],
        strands: [
            {
                checkboxName: "s1",
                label: "Understanding",
                tooltip:
                    "Teachers support students in developing a deep understanding of key concepts.",
                domainColumn: "U",
                cssClass: "n1",
                slug: "understanding",
            },
            {
                checkboxName: "s2",
                label: "Multi-dimensional Learning",
                tooltip:
                    "Teachers support students in demonstrating their learning in multiple ways.",
                domainColumn: "MDL",
                cssClass: "n2",
                slug: "multi-dimensional-learning",
            },
            {
                checkboxName: "s3",
                label: "Reasoned Arguments",
                tooltip: "Teachers support students in constructing reasoned arguments.",
                domainColumn: "RA",
                cssClass: "n3",
                slug: "reasoned-arguments",
            },
            {
                checkboxName: "s4",
                label: "Repertoire of Techniques",
                tooltip: "Teachers support students in developing a repertoire of techniques.",
                domainColumn: "RoTech",
                cssClass: "n4",
                slug: "repertoire-of-techniques",
            },
            {
                checkboxName: "s5",
                label: "Learning Spaces",
                tooltip: "Teachers support students in using learning spaces effectively.",
                domainColumn: "LS",
                cssClass: "n5",
                slug: "learning-spaces",
            },
        ],
    },
    tl3: {
        id: "tl3",
        title: "TL3: Evidence of Learning",
        shortLabel: "Evidence",
        navLabel: "Evidence (TL3)",
        description:
            "Use clear goals, varied assessment and descriptive feedback to help students understand and direct their own progress.",
        standards: [
            "Clearly communicates learning goals, providing students with rubrics, scoring guides, and exemplars to guide their progress toward meeting expectations.",
            "Uses a variety of informal and formal methods of assessment to measure student learning, growth, and understanding.",
            "Provides students descriptive feedback to improve their performance.",
            "Teaches students to reflect on their performance and set learning goals, actively engaging them in using assessment results to drive improvement.",
            "Analyzes student data to identify trends and adjust instruction, providing targeted support based on observed learning needs.",
            "Adapts and differentiates learning experiences to improve future instruction.",
            "Monitors the performance of each student and devises instruction to enable students to grow and develop.",
        ],
        topics: ["Reflect on thinking", "Evidence of student learning", "Employ feedback"],
        strands: [
            {
                checkboxName: "s1",
                label: "Reflect on Thinking",
                tooltip: "Teachers support students in reflecting on their thinking.",
                domainColumn: "RoThink",
                cssClass: "n1",
                slug: "reflect-on-thinking",
            },
            {
                checkboxName: "s2",
                label: "Evidence of Student Learning",
                tooltip: "Teachers use evidence of student learning to inform instruction.",
                domainColumn: "EoST",
                cssClass: "n2",
                slug: "evidence-of-student-learning",
            },
            {
                checkboxName: "s3",
                label: "Employ Feedback",
                tooltip: "Teachers employ feedback to guide student learning.",
                domainColumn: "EF",
                cssClass: "n3",
                slug: "employ-feedback",
            },
        ],
    },
    tl4: {
        id: "tl4",
        title: "TL4: Crafting the Curriculum",
        shortLabel: "Crafting",
        navLabel: "Crafting (TL4)",
        description:
            "Design coherent units, communicate high expectations and challenge students with complex, evidence-based work.",
        standards: [
            "Designs units that build on prior knowledge, with observable connections to prior lessons that help students see learning as a progression.",
            "Establishes clear objectives for each unit, ensuring students understand what they are working to achieve and why.",
            "Demonstrates understanding of the importance of long-range planning, curriculum development, and lesson sequencing.",
            "Communicates high expectations, encouraging learners to engage fully and maintain strong effort while developing increased resiliency and independence.",
            "Delivers instruction that challenges students to acquire complex knowledge and skills, seen through active engagement with subject-specific vocabulary and tasks.",
            "Provides students with opportunities to make evidence-based arguments and assess claims, guiding them in developing critical thinking skills.",
        ],
        topics: [
            "Risk-taking environment",
            "Deepening lines of inquiry",
            "Responsibility and citizenship",
        ],
        strands: [
            {
                checkboxName: "s1",
                label: "Risk-taking Environment",
                tooltip: "Teachers create a risk-taking environment for learning.",
                domainColumn: "RTE",
                cssClass: "n1",
                slug: "risk-taking-environment",
            },
            {
                checkboxName: "s2",
                label: "Deepening Lines of Inquiry",
                tooltip: "Teachers support students in deepening lines of inquiry.",
                domainColumn: "DLoI",
                cssClass: "n2",
                slug: "deepening-lines-of-inquiry",
            },
            {
                checkboxName: "s3",
                label: "Responsibility and Citizenship",
                tooltip:
                    "Teachers support students in developing responsibility and aspects of citizenship.",
                domainColumn: "RaAoC",
                cssClass: "n3",
                slug: "responsibility-and-citizenship",
            },
        ],
    },
    tl5: {
        id: "tl5",
        title: "TL5: Professional Growth",
        shortLabel: "Growth",
        navLabel: "Growth (TL5)",
        description:
            "Reflect on practice, set growth goals and use professional learning to improve instruction and student outcomes.",
        standards: [
            "Actively engages in self-reflection, regularly assessing the impact of instructional choices and interactions on student learning and classroom dynamics.",
            "Sets personal growth goals, collaborates with colleagues, and seeks feedback to refine teaching strategies and improve student outcomes.",
            "Pursues professional development opportunities that enhance instructional practices and deepen content knowledge, demonstrating a commitment to continuous improvement.",
            "Demonstrates adaptability by integrating new teaching methods, tools, and resources based on best practices and current research in education.",
            "Upholds the highest standards of ethical, culturally responsive, and collaborative practices, consistently striving to promote the learning and growth of all students.",
        ],
        topics: [
            "Self-reflection",
            "Growth goals",
            "Professional development",
            "Adaptability",
            "Ethical practice",
        ],
        strands: [],
    },
    tl6: {
        id: "tl6",
        title: "TL6: Contribution to Workplace Positivity",
        shortLabel: "Positivity",
        navLabel: "Positivity (TL6)",
        description:
            "Model reliability, integrity and respectful communication to build a collaborative and supportive school community.",
        standards: [
            "Fulfills all professional responsibilities and contractual obligations promptly and reliably, setting a positive example for colleagues and students alike.",
            "Exhibits professional judgment and integrity, consistently adhering to the network's ethical guidelines and maintaining confidentiality with regard to student information.",
            "Communicates effectively and respectfully with students, families, and colleagues, using verbal, nonverbal, and digital tools to foster a collaborative and inclusive environment.",
            "Contributes to a positive workplace culture by demonstrating support and collegiality, helping to create a collaborative and supportive school environment.",
        ],
        topics: [
            "Professional responsibilities",
            "Judgment and integrity",
            "Communication",
            "Collegiality",
        ],
        strands: [],
    },
};

export const tlList: TLConfig[] = Object.values(tlConfigs);
export const tlFields = tlList.map((config) => `${config.id}_desc` as const);

export function getTlConfig(id: string): TLConfig | null {
    return Object.prototype.hasOwnProperty.call(tlConfigs, id) ? tlConfigs[id] : null;
}

export function getStrand(tl: string, slug: string): StrandConfig | null {
    const config = getTlConfig(tl);
    if (!config) return null;
    return config.strands.find((strand) => strand.slug === slug) ?? null;
}

export function strandColumnNames(): string[] {
    return tlList.flatMap((config) => config.strands.map((strand) => strand.domainColumn));
}

export interface StrandRef extends StrandConfig {
    tl: string;
    tlTitle: string;
}

/** Every strand across TL1-TL4, for filtering write-up domains. */
export function allStrands(): StrandRef[] {
    return tlList.flatMap((config) =>
        config.strands.map((strand) => ({
            ...strand,
            tl: config.id,
            tlTitle: config.title,
        }))
    );
}

export function strandFilterName(column: string): string {
    return `st_${column}`;
}
