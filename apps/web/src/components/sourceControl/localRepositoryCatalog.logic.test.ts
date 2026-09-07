import { describe, expect, it } from "vite-plus/test";
import { filterLocalProjects } from "./localRepositoryCatalog.logic";

const projects = [
  {
    id: "same-id",
    environmentId: "mac",
    title: "Backend",
    workspaceRoot: "/Users/dev/backend",
    repositoryIdentity: null,
  },
  {
    id: "same-id",
    environmentId: "gpu",
    title: "Backend",
    workspaceRoot: "/srv/backend",
    repositoryIdentity: null,
  },
  {
    id: "notes",
    environmentId: "mac",
    title: "Notes",
    workspaceRoot: "/Users/dev/notes",
    repositoryIdentity: null,
  },
];
describe("local repository catalog", () => {
  it("preserves projects across environments and includes folders without remote accounts", () => {
    expect(filterLocalProjects(projects, "")).toBe(projects);
    expect(filterLocalProjects(projects, "backend")).toEqual(projects.slice(0, 2));
  });
  it("searches case-insensitive title and path terms together", () => {
    expect(filterLocalProjects(projects, " BACKEND /srv ")).toEqual([projects[1]]);
    expect(filterLocalProjects(projects, "notes")).toEqual([projects[2]]);
    expect(filterLocalProjects(projects, "unknown")).toEqual([]);
  });
});
