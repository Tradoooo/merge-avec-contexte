/**
 * Tests de la publication partagée (`scripts/publier-preuve.ts`), sans dépôt
 * ni réseau : un faux git reproduit la sémantique utile — `fetch` aligne la
 * référence locale sur la tête distante, `push` n'accepte qu'un avancement
 * rapide (le commit dont le parent est la tête distante). C'est exactement ce
 * qui rendait `demo-live` rouge : branche orpheline + `--force-with-lease`
 * sans fetching → « stale info », et réécriture de l'historique de l'autre
 * écrivain.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  analyserArgs, argsUtiles, construireCommit, gitDePas, publier, telecharger,
  teteDistante, usage,
} from '../publier-preuve';

/** Faux git : une branche, son historique, et la course entre deux écrivains. */
class FauxGit {
  distante: string | null = null;
  locale: string | null = null;
  /** Parent de chaque commit construit (id → parent, null = racine). */
  parents = new Map<string, string | null>();
  pusses: string[] = [];
  #blobs = 0;
  #arbres = 0;
  #commits = 0;

  executer = (args: string[], entree?: string): string => {
    const commande = args.find((a) => !a.startsWith('-') && !a.includes('=')) ?? args[0];
    if (commande === 'hash-object') return this.#empreinte('BLOB', entree);
    if (commande === 'mktree') return this.#empreinte('ARBRE', entree);
    if (commande === 'commit-tree') return this.#commitTree(args);
    if (commande === 'fetch') { this.locale = this.distante; return ''; }
    if (commande === 'rev-parse') return this.locale ?? '';
    if (commande === 'push') return this.#push(args);
    throw new Error(`commande non simulée : ${args.join(' ')}`);
  };

  #empreinte(prefixe: 'BLOB' | 'ARBRE', entree?: string): string {
    if (prefixe === 'BLOB') this.#blobs += 1;
    else this.#arbres += 1;
    const n = prefixe === 'BLOB' ? this.#blobs : this.#arbres;
    return `${prefixe}${n}-${(entree ?? '').length}`;
  }

  #commitTree(args: string[]): string {
    const index = args.indexOf('-p');
    const parent = index >= 0 ? args[index + 1] : null;
    this.#commits += 1;
    const id = `C${this.#commits}`;
    this.parents.set(id, parent);
    return id;
  }

  #push(args: string[]): string {
    const [commit, ref] = args[args.length - 1].split(':');
    expect(ref).toBe('refs/heads/data-live');
    if (this.distante && this.parents.get(commit) !== this.distante) {
      throw new Error('non-fast-forward: la branche a bougé');
    }
    this.pusses.push(commit);
    this.distante = commit;
    return '';
  }
}

const DOSSIER = mkdtempSync(join(tmpdir(), 'mac-publier-'));
const RAPPORT = join(DOSSIER, 'preuve.json');
writeFileSync(RAPPORT, '{"horodatage":"2026-11-14T12:00:00Z","etapes":[]}\n');

const OPTIONS = {
  rapport: RAPPORT, branche: 'data-live', message: 'démo réelle test', essais: 3,
};

describe('publier', () => {
  let git: FauxGit;
  beforeEach(() => { git = new FauxGit(); });

  it('crée la branche quand elle n’existe pas (commit sans parent)', () => {
    const commit = publier(git.executer, OPTIONS);
    expect(git.parents.get(commit)).toBeNull();
    expect(git.distante).toBe(commit);
  });

  it('empile sur la tête distante — jamais de réécriture', () => {
    git.distante = 'AVANT';
    const commit = publier(git.executer, OPTIONS);
    expect(git.parents.get(commit)).toBe('AVANT');
    expect(git.distante).toBe(commit);
  });

  it('reconstruit quand l’autre écrivain a publié entre-temps', () => {
    git.distante = 'A1';
    git.parents.set('A1', null);
    const original = git.executer;
    let bascule = false;
    const executer = (args: string[], entree?: string): string => {
      const sortie = original(args, entree);
      // Entre notre commit et notre push, l’autre écrivain a publié A2.
      if (!bascule && args.includes('commit-tree')) {
        bascule = true;
        git.parents.set('A2', git.distante);
        git.distante = 'A2';
      }
      return sortie;
    };
    const commit = publier(executer, OPTIONS);
    // Deux commits construits : le premier (parent A1) est refusé, le second
    // reconstruit au-dessus de A2 — la publication reste un avancement rapide.
    expect(commit).toBe('C2');
    expect(git.parents.get('C1')).toBe('A1');
    expect(git.parents.get('C2')).toBe('A2');
    expect(git.pusses).toEqual([commit]);
    expect(git.distante).toBe(commit);
  });

  it('échoue proprement après `essais` tentatives', () => {
    git.distante = 'A1';
    const original = git.executer;
    const executer = (args: string[], entree?: string): string => {
      if (args.includes('push')) throw new Error('stale info');
      return original(args, entree);
    };
    expect(() => publier(executer, { ...OPTIONS, essais: 2 })).toThrow(/2 essai\(s\)/);
  });
});

describe('analyserArgs', () => {
  it('exige le rapport et applique les défauts', () => {
    expect(analyserArgs([RAPPORT])).toEqual({
      rapport: RAPPORT, branche: 'data-live', message: expect.any(String), essais: 3,
    });
  });

  it('accepte branche, message et essais explicites', () => {
    const options = analyserArgs([RAPPORT, '--branche', 'x', '--message', 'm', '--essais', '5']);
    expect(options).toMatchObject({ branche: 'x', message: 'm', essais: 5 });
  });

  it('refuse un argument invalide', () => {
    expect(() => analyserArgs([])).toThrow(/Usage/);
    expect(() => analyserArgs([RAPPORT, 'autre'])).toThrow(/Usage/);
    expect(() => analyserArgs([RAPPORT, '--inconnu', 'v'])).toThrow(/Option inconnue/);
    expect(() => analyserArgs([RAPPORT, '--essais'])).toThrow(/sans valeur/);
    expect(() => analyserArgs([RAPPORT, '--essais', '0'])).toThrow(/invalide/);
  });
});

/** Chemin du module, tel que `vite-node` le place dans `process.argv`. */
const MODULE = new URL('../publier-preuve.ts', import.meta.url).pathname;

describe('argsUtiles', () => {
  it('retire le chemin du script (invocation vite-node)', () => {
    expect(argsUtiles([MODULE, RAPPORT, '--essais', '2'], MODULE)).toEqual([RAPPORT, '--essais', '2']);
  });

  it('laisse les arguments intacts (invocation node, ou rapport nommé publier-preuve.ts)', () => {
    expect(argsUtiles([RAPPORT, '--essais', '2'], MODULE)).toEqual([RAPPORT, '--essais', '2']);
    expect(argsUtiles([], MODULE)).toEqual([]);
  });
});

describe('usage', () => {
  it('nomme les trois options', () => {
    for (const option of ['--branche', '--message', '--essais']) expect(usage()).toContain(option);
  });
});

describe('teteDistante / telecharger', () => {
  it('rend null quand la branche est absente, la tête après fetch sinon', () => {
    const git = new FauxGit();
    expect(teteDistante(git.executer, 'data-live')).toBeNull();
    git.distante = 'ABC';
    expect(telecharger(git.executer, 'data-live')).toBe('ABC');
  });
});

describe('construireCommit', () => {
  it('pose l’identité et relie au parent demandé', () => {
    const git = new FauxGit();
    const commit = construireCommit(git.executer, RAPPORT, 'P1', 'message', {
      nom: 'b', courriel: 'b@local',
    });
    expect(git.parents.get(commit)).toBe('P1');
  });
});

describe('gitDePas', () => {
  it('exécute git dans le dépôt et rend la sortie', () => {
    expect(gitDePas(process.cwd())(['rev-parse', '--git-dir'])).toBeTruthy();
  });
});
