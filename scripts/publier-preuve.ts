#!/usr/bin/env node
/**
 * Publie le rapport de la démonstration réelle sur la branche `data-live`.
 *
 * La page publique lit cette branche (`site/temps-reel.js` →
 * `raw.githubusercontent.com/.../data-live/preuve.json`) : c'est le canal de
 * la « preuve en direct ». Deux écrivains l'alimentent — le workflow GitHub
 * `demo-live` (30 min) et le déclencheur local `mac-preuve-live` (15 min) —
 * et passent tous deux par **ce** script : une seule implémentation, donc un
 * seul comportement.
 *
 * Règles de publication (fix du 14/11, après 3 jours de `demo-live` rouge) :
 *  - historique **linéaire** : chaque commit a la tête distante pour parent ;
 *  - push **sans réécriture** : aucun push forcé, aucune branche orpheline ;
 *  - commit construit par « plumbing » (`hash-object`, `mktree`,
 *    `commit-tree`) : l'arbre de travail n'est jamais touché.
 *
 * L'exécuteur git est injecté (`ExecuteurGit`) : les tests jouent la
 * publication sur un faux git, sans dépôt ni réseau.
 *
 * Usage : npx vite-node scripts/publier-preuve.ts <rapport.json>
 *         [--branche data-live] [--message "texte"] [--essais 3]
 * Codes : 0 = publié, 1 = échec, 2 = usage.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Exécute une commande git (sortie texte) ; lève en cas d'échec. */
export type ExecuteurGit = (args: string[], entree?: string) => string;

export const BRANCHE_DEFAUT = 'data-live';
export const NOM_RAPPORT = 'preuve.json';
export const ESSAIS_DEFAUT = 3;
const OPTIONS = ['--branche', '--message', '--essais'];

/** Usage affiché quand les arguments ne conviennent pas. */
export function usage(): string {
  return 'Usage : npx vite-node scripts/publier-preuve.ts <rapport.json>'
    + ' [--branche data-live] [--message "texte"] [--essais 3]';
}

/** Analyse les arguments de ligne de commande ; lève une erreur d'usage sinon. */
export function analyserArgs(argv: string[]): {
  rapport: string; branche: string; message: string; essais: number;
} {
  const positionnels: string[] = [];
  const options: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const argument = argv[i];
    if (!argument.startsWith('--')) {
      positionnels.push(argument);
      continue;
    }
    if (!OPTIONS.includes(argument)) throw new Error(`Option inconnue : ${argument}\n${usage()}`);
    const valeur = argv[i + 1];
    if (valeur === undefined || valeur.startsWith('--')) {
      throw new Error(`Option sans valeur : ${argument}\n${usage()}`);
    }
    options[argument] = valeur;
    i += 1;
  }
  if (positionnels.length !== 1) throw new Error(usage());
  const essais = Number(options['--essais'] ?? ESSAIS_DEFAUT);
  if (!Number.isInteger(essais) || essais < 1) {
    throw new Error(`Nombre d’essais invalide : ${options['--essais']}\n${usage()}`);
  }
  return {
    rapport: positionnels[0],
    branche: options['--branche'] ?? BRANCHE_DEFAUT,
    message: options['--message'] ?? `démo réelle ${new Date().toISOString().split('.')[0]}Z`,
    essais,
  };
}

/** Fabrique un exécuteur git réel dans un dépôt donné. */
export function gitDePas(cwd: string): ExecuteurGit {
  return (args, entree) => execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    input: entree,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/** Tête distante connue de la branche (après `fetch`), ou null si absente. */
export function teteDistante(git: ExecuteurGit, branche: string): string | null {
  try {
    return git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branche}`]).trim() || null;
  } catch {
    return null; // `--quiet` lève sur une référence absente : branche à créer.
  }
}

/** Récupère la branche distante (historique borné : un seul commit suffit). */
export function telecharger(git: ExecuteurGit, branche: string): string | null {
  try {
    git(['fetch', '--no-tags', '--depth=1', 'origin',
      `+refs/heads/${branche}:refs/remotes/origin/${branche}`]);
  } catch {
    return null; // branche absente du dépôt : la publication la créera.
  }
  return teteDistante(git, branche);
}

/**
 * Construit le commit portant le rapport : un blob, un arbre à un fichier, un
 * commit dont le parent est la tête distante (ou aucun : branche naissante).
 * L'identité est posée explicitement (`commit-tree` en a besoin, et un runner
 * GitHub n'a aucun `user.email` configuré).
 */
export function construireCommit(
  git: ExecuteurGit,
  rapport: string,
  parent: string | null,
  message: string,
  identite: { nom: string; courriel: string } = { nom: 'b', courriel: 'b@local' },
): string {
  const blob = git(['hash-object', '-w', '--stdin'], readFileSync(rapport, 'utf8')).trim();
  const arbre = git(['mktree'], `100644 blob ${blob}\t${NOM_RAPPORT}\n`).trim();
  const args = ['-c', `user.name=${identite.nom}`, '-c', `user.email=${identite.courriel}`,
    'commit-tree', arbre, ...(parent ? ['-p', parent] : []), '-m', message];
  return git(args).trim();
}

/**
 * Publie le rapport : télécharge, construit au-dessus de la tête, pousse.
 * Si le push est refusé (l'autre écrivain a publié entre-temps), on
 * retélécharge et on reconstruit — jusqu'à `options.essais` tentatives.
 */
export function publier(git: ExecuteurGit, options: {
  rapport: string; branche: string; message: string; essais: number;
  identite?: { nom: string; courriel: string };
}): string {
  let dernierEchec = '';
  for (let essai = 1; essai <= options.essais; essai += 1) {
    const parent = telecharger(git, options.branche);
    const commit = construireCommit(git, options.rapport, parent, options.message, options.identite);
    try {
      git(['push', 'origin', `${commit}:refs/heads/${options.branche}`]);
      return commit;
    } catch (erreur) {
      dernierEchec = String((erreur as { stderr?: string; message?: string }).stderr
        ?? (erreur as Error).message ?? erreur);
      process.stderr.write(`publier-preuve : refusé (essai ${essai}/${options.essais}) —`
        + ` la branche a bougé, on reconstruit.\n`);
    }
  }
  throw new Error(`Publication impossible après ${options.essais} essai(s) : ${dernierEchec.trim()}`);
}

/** Chemin absolu de ce module (l'entrée CLI est partagée node / vite-node). */
export const CHEMIN_MODULE = fileURLToPath(import.meta.url);

/**
 * Arguments utiles de la ligne de commande : sous `vite-node`, le chemin du
 * script est passé comme premier argument (contrairement à `node`, où
 * `process.argv.slice(2)` l'exclut déjà). On le retire quand il présent.
 */
export function argsUtiles(argv: string[], cheminModule: string = CHEMIN_MODULE): string[] {
  return argv.length > 0 && argv[0].endsWith('.ts') && resolve(argv[0]) === cheminModule
    ? argv.slice(1)
    : argv;
}

/* L'entrée CLI : même idiome que `scripts/preuve-reelle.ts` — sous `vite-node`,
 * `process.argv[1]` est le binaire et non le script, donc une comparaison de
 * chemins ne s'évalue jamais. Les tests posent `VITEST` : l'import par les
 * tests n'exécute rien, l'invocation directe publie. */
if (!process.env.VITEST) {
  try {
    const options = analyserArgs(argsUtiles(process.argv.slice(2)));
    const git = gitDePas(resolve(CHEMIN_MODULE, '..', '..'));
    const commit = publier(git, options);
    process.stdout.write(`publier-preuve : ${options.branche} → ${commit.slice(0, 12)}\n`);
  } catch (erreur) {
    process.stderr.write(`${(erreur as Error).message}\n`);
    process.exit((erreur as Error).message.includes('Usage') ? 2 : 1);
  }
}
