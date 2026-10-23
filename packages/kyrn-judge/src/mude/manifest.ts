/**
 * mude, the decision model trained for mu's judgment layer, as one package of files at a fixed revision of its
 * Hugging Face repository: the Apple silicon (MLX, 8-bit) edition, with the System One server that comes in it
 * (`d3_server_mac.py`). Every file is pinned by size and sha256 here, not by the manifest that is downloaded with
 * them, so a changed file is refused rather than run.
 */

export const MUDE_REPO = "qybaihe/mude-2b-mlx-8bit";
export const MUDE_REVISION = "c7378c8a3a90d48f32ee924b78b070f493302898";

/** The name the server reports and mu's judge asks for. */
export const MUDE_MODEL = "mude";

export interface MudeFile {
	readonly path: string;
	readonly size: number;
	readonly sha256: string;
}

const FILES: ReadonlyArray<readonly [string, number, string]> = [
	[".gitattributes", 1570, "34448b82c17d60fec9b65b1f093c115ddbaadc04beb1b0140b6bfed2e012a930"],
	["LICENSE", 1482, "793a9f63a9cdfd3436ca19a4a70e54d1acf9d639d84ba27129918284765f3a05"],
	["LICENSES/Apache-2.0.txt", 11357, "c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4"],
	["MODEL_MANIFEST.json", 19131, "2a09c9d8228923fd12097ce0449f04facbfda6fdd8a5ecc48dbdea5f936214d2"],
	["NOTICE", 1827, "557b1ddfbf5a545f3ec99cdf2510a220d8b4b7e40f5bd37b3cf7295dfaee01f3"],
	["README.md", 1971, "9c7dcef33125996feace6d0e444daea1819f4affcd69b015fc68066b72039d87"],
	["chat_template.jinja", 7755, "273d8e0e683b885071fb17e08d71e5f2a5ddfb5309756181681de4f5a1822d80"],
	["config.json", 2783, "4fba61002dea71507b2ea7d9910a70bb7df8f0a0639e2b2ffae2b978ddb9874b"],
	["d3_engine.py", 4413, "086238942762df45047a32cd9a8e2bedd9b63167eb40be260c776de567979f53"],
	["d3_fast.py", 22331, "68a1fb9a2c3bde9ac2763bf504decae592ca12722698fbde1b39a31262955535"],
	["d3_format.py", 7008, "3badfbc70561bb3f5b8ec16a11d2c455b96ddb32caace0a8a54ca102eae1f3fa"],
	["d3_kernels.py", 16129, "8f7534ca1e1846ebf7c4c73058002f3be4dbf0d5d426f0815150ae0cbe7677bd"],
	["d3_mac.py", 10824, "5ab4f773a7361656a765b5be351e2cde519b3094c0b4a66123d01b2ac2f40372"],
	["d3_mlx.py", 15876, "04890d713a240f7ff7d53ebb250b88ef85f9c04948f322a46006506f1e33e48d"],
	["d3_runtime.py", 98229, "a77a0b84c1732a0fd6296e0daa44cd86130f67bfea5e9c87eee8c5a1df293def"],
	["d3_server.py", 17705, "766a20a69101e36ab0535a1ec683379db422380a83091f0eccd7e82edb6a02de"],
	["d3_server_mac.py", 1216, "0e351b255fac166d71489e95b68d761d1d91d10297dbcfc16a1c42a659b7b396"],
	["decision_config.json", 5509, "19c62c4a8b0ff7bd1f82c05ef0d7af8df4b2ce7af2cfe19e3989e7d9f6c1c1cc"],
	["merges.txt", 3353259, "a9d356d7bdf1ef4949e3e748e95b8e10ad9d4e2e838eddc38a0a7b6b94d1db8d"],
	["mlx-q8.safetensors", 1756751774, "9757238f601c7b2eea997069add5856ba5ed8370786bfffae0b9ac550c33f697"],
	["mlx_weights.json", 293, "747ece4d690e493dda9637917b3d8b9c1296ccfa4a258f51c0ae0ad716a1d698"],
	["modeling_d3.py", 12079, "f8f8db23ff58f1a990ffa24977d744a50e1b4446d02a64c22070967705b6dbef"],
	["pipeline_d3.py", 2936, "4f9297c7c74e596e9b67df91a1e6823cfada48bf781336f141974ff6a2f1038e"],
	["preprocessor_config.json", 390, "27225450ac9c6529872ee1924fcb0962ff5634834f817040f444118116f4e516"],
	["readout.safetensors", 2089040, "aeb18e2f9289aab0012e2059264326fb850aa8c5d8537975a891cf9655811674"],
	["requirements-mac.txt", 289, "ed16543a58d7ffd2f19e17b38f8b9e46775548700d9d3eaca7a592309a8741b5"],
	["requirements.txt", 723, "de9defd71ae4e559a7f5bdcc935b23716f9788e8755f2ba6db1ab6862bcda12e"],
	["tokenizer.json", 12807982, "5f9e4d4901a92b997e463c1f46055088b6cca5ca61a6522d1b9f64c4bb81cb42"],
	["tokenizer_config.json", 16709, "49e2b6e395f959f077f1e992b338919c0d4a9732fc6e613995e06557f843500c"],
	["video_preprocessor_config.json", 385, "7768af27c1fafa9cc9011c1dc20067e03f8915e03b63504550e11d5066986d13"],
	["vocab.json", 6722759, "ce99b4cb2983d118806ce0a8b777a35b093e2000a503ebde25853284c9dfa003"],
];

export const MUDE_FILES: readonly MudeFile[] = FILES.map(([path, size, sha256]) => ({ path, size, sha256 }));

/** 1,782,005,734 bytes. */
export const MUDE_BYTES = MUDE_FILES.reduce((sum, file) => sum + file.size, 0);

/** Where a file of the pinned revision is downloaded from. */
export function mudeFileUrl(path: string, endpoint = "https://huggingface.co"): string {
	return `${endpoint.replace(/\/+$/, "")}/${MUDE_REPO}/resolve/${MUDE_REVISION}/${path.split("/").map(encodeURIComponent).join("/")}`;
}
