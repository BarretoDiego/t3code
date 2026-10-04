/**
 * What the agent is asked during a fork sync. The prompts are in Portuguese
 * because the fork's history and its merge messages are.
 */
import type { ForkSyncConfig } from "./config.ts";

const FORBIDDEN_GIT =
  "git commit, git merge, git rebase, git reset, git checkout, git branch, git stash, git push, git clean";

export function conflictPrompt(input: {
  readonly config: ForkSyncConfig;
  readonly forkCommits: string;
  readonly conflicts: ReadonlyArray<string>;
}): string {
  const { config } = input;
  const upstream = `${config.upstreamRemote}/${config.upstreamBranch}`;
  return `Voce esta dentro de um merge do git em andamento no diretorio ${config.worktree}.

CONTEXTO
- Repositorio: um fork do projeto T3 Code (pingdotgg/t3code).
- Estamos trazendo \`${upstream}\` (a branch de onde saem as builds nightly do projeto original) para dentro da branch \`${config.targetBranch}\` do fork.
- A branch do fork carrega modificacoes proprias que PRECISAM continuar existindo e funcionando depois do merge.

Commits proprios do fork (nao existem no upstream):
${input.forkCommits}

ARQUIVOS EM CONFLITO (${input.conflicts.length}):
${input.conflicts.join("\n")}

SUA TAREFA
Resolver TODOS os conflitos acima, editando os arquivos.

REGRAS OBRIGATORIAS
1. Nenhum marcador de conflito (<<<<<<<, =======, >>>>>>>) pode sobrar em nenhum arquivo.
2. Preserve AS DUAS intencoes: a evolucao do upstream E as modificacoes do fork. Quando as duas mexem no mesmo ponto, combine-as.
3. NUNCA descarte uma modificacao do fork so para "simplificar" o merge. Se o upstream refatorou/renomeou a area, READAPTE a modificacao do fork para a nova estrutura e API.
4. Se o upstream removeu algo que a modificacao do fork usava, encontre o equivalente novo e use. So remova a modificacao do fork se ela tiver virado literalmente redundante porque o upstream implementou a mesma coisa, e nesse caso explique no resumo.
5. Prefira a versao do upstream em arquivos gerados/lockfiles (pnpm-lock.yaml, *.lock, dist, snapshots) quando nao houver alteracao do fork ali.
6. So edite arquivos em conflito. Editar um arquivo fora da lista e permitido apenas se for necessario para o codigo continuar compilando depois da sua resolucao.
7. PROIBIDO rodar: ${FORBIDDEN_GIT}. Quem chamou voce cuida disso. Voce pode ler o repositorio (git diff, git log, git show) e editar arquivos.
8. Leia o codigo ao redor antes de resolver. Nao chute assinaturas de funcao nem nomes de tipo.

Ao terminar, responda com um resumo de no maximo 10 linhas: um item por arquivo, dizendo como resolveu.`;
}

export function fixPrompt(input: {
  readonly config: ForkSyncConfig;
  readonly packageManager: string;
  readonly failure: string;
}): string {
  const { config, packageManager } = input;
  return `Voce esta em ${config.worktree}, logo apos resolver um merge de \`${config.upstreamRemote}/${config.upstreamBranch}\` na branch \`${config.targetBranch}\` de um fork do T3 Code.
O merge ja esta staged, mas \`${packageManager} run typecheck\` e/ou \`${packageManager} run lint\` estao falhando.

SAIDA DA FALHA (ultimas linhas):
${input.failure}

TAREFA: corrigir os erros acima editando o codigo, de forma que \`${packageManager} run typecheck\` e \`${packageManager} run lint\` passem.

REGRAS
1. Corrija a causa real. Nao silencie erro com \`any\`, \`@ts-ignore\`, \`eslint-disable\`/\`oxlint-disable\` nem removendo codigo util.
2. NAO remova as modificacoes proprias do fork para fazer o typecheck passar. Se o upstream mudou a API que elas usam, adapte-as.
3. PROIBIDO rodar: ${FORBIDDEN_GIT}.
4. Voce PODE rodar \`${packageManager} run typecheck\` e \`${packageManager} run lint\` para conferir seu progresso.
Ao terminar, resuma em ate 8 linhas o que corrigiu.`;
}

export function commitMessagePrompt(input: {
  readonly config: ForkSyncConfig;
  readonly upstreamShort: string;
  readonly commitCount: number;
  readonly conflicts: number;
  readonly titles: string;
  readonly diffstat: string;
}): string {
  const { config } = input;
  const upstream = `${config.upstreamRemote}/${config.upstreamBranch}`;
  return `Escreva a mensagem de commit de um merge do git. Responda SOMENTE com a mensagem, sem crases, sem markdown, sem comentarios seus. NAO edite nenhum arquivo e NAO rode comandos: tudo que voce precisa esta abaixo.

Contexto: merge automatico de \`${upstream}\` (upstream pingdotgg/t3code, branch das nightlies, commit ${input.upstreamShort}) para a branch \`${config.targetBranch}\` de um fork que carrega modificacoes proprias. Foram ${input.commitCount} commits do upstream. Conflitos resolvidos: ${input.conflicts}.

Commits que entraram (amostra):
${input.titles}

Diffstat:
${input.diffstat}

FORMATO EXIGIDO
Linha 1 (titulo, ate 72 chars): chore(sync): merge ${upstream} (${input.upstreamShort}) — <resumo curto do que entrou>
Linha 2: vazia
Corpo: 3 a 8 bullets em portugues, comecando com "- ", agrupando os temas principais que entraram do upstream. Se houve conflito, um bullet final dizendo quantos arquivos conflitaram e como foram resolvidos (mantendo as modificacoes do fork).
Nao invente mudancas que nao estao na lista.`;
}

/** The agent's reply as a commit message: code fences dropped, blank lines collapsed. */
export function cleanCommitMessage(reply: string): string {
  const lines: Array<string> = [];
  let pendingBlank = false;
  for (const line of reply.split("\n")) {
    if (line.trimStart().startsWith("```")) continue;
    if (line.trim().length === 0) {
      pendingBlank = lines.length > 0;
      continue;
    }
    if (pendingBlank) lines.push("");
    pendingBlank = false;
    lines.push(line.trimEnd());
  }
  return lines.join("\n");
}

export function fallbackCommitMessage(input: {
  readonly config: ForkSyncConfig;
  readonly upstreamShort: string;
  readonly commitCount: number;
  readonly conflicts: number;
  readonly verify: string;
}): string {
  const { config } = input;
  return [
    `chore(sync): merge ${config.upstreamRemote}/${config.upstreamBranch} (${input.upstreamShort}) na ${config.targetBranch} do fork`,
    "",
    `- ${input.commitCount} commits trazidos de ${config.upstreamRemote}/${config.upstreamBranch}`,
    `- ${input.conflicts} arquivo(s) em conflito`,
    `- verificacao: ${input.verify}`,
  ].join("\n");
}
