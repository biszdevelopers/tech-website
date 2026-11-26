import { Application } from "../core/01-application";
import { render } from "../core/views";
import { env } from "../config/env";

export function registerAdminAccountRoutes(app: Application): void {
    app.get(
        "/admin/account",
        async (ctx) => {
            ctx.htmlRaw(render("admin-account", { username: env.adminUsername }));
        },
        { guard: "mainAdmin" }
    );
}
