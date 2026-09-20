"""
Cut a local FlyWire v783 subgraph for the bar game.

Sources (already in ./data):
  - Connectivity_783.parquet / Completeness_783.csv
      Shiu et al. Nature 2024 companion files (FlyWire public v783).
      Weight column is signed synapse count: Excitatory x Connectivity.
  - flywire_annotations.tsv
      Schlegel et al. Nature 2024, updated with Berg et al. MaleCNS mapping
      (dimorphism, fru_dsx, flywire↔male type synonyms).
  - male_body_annotations.feather
      MaleCNS v1.0 type census (Janelia). Used to name MN9 and confirm
      isomorphic types exist in the male. Full MaleCNS edge table is 1.1 GB;
      feeding/steering hubs we need are annotated isomorphic, so both flies
      run the FlyWire motif. Male drops female-specific cells.

We do NOT load optic-lobe neurons into the hops. That is the difference
between a laptop subgraph and Shiu's 139k-cell whole brain.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"

# Shiu example.ipynb sugar GRNs (v630 IDs that still resolve in v783).
SHIU_SUGAR = [
    720575940624963786, 720575940630233916, 720575940637568838,
    720575940638202345, 720575940617000768, 720575940630797113,
    720575940632889389, 720575940621754367, 720575940621502051,
    720575940640649691, 720575940639332736, 720575940616885538,
    720575940639198653, 720575940620900446, 720575940617937543,
    720575940632425919, 720575940633143833, 720575940612670570,
    720575940628853239, 720575940629176663, 720575940611875570,
]
SHIU_MN9 = 720575940660219265  # example.ipynb; MaleCNS type MN9 = FlyWire CB0701


def _mask(ann: pd.DataFrame, **eq) -> pd.Series:
    m = pd.Series(True, index=ann.index)
    for col, val in eq.items():
        m &= ann[col].astype(str) == str(val)
    return m


def select_seeds(ann: pd.DataFrame) -> dict[str, np.ndarray]:
    """Hub cell types we actually drive or read out."""
    ct = ann["cell_type"].astype(str)
    sub = ann["cell_sub_class"].astype(str)
    cls = ann["cell_class"].astype(str)
    syn = ann["synonyms"].astype(str)

    sugar = ann.loc[
        (sub.str.contains("sugar", case=False, na=False))
        | (ann["root_id"].isin(SHIU_SUGAR)),
        "root_id",
    ]
    mn = ann.loc[
        sub.isin(["proboscis_motor_neuron", "ingestion_motor_neuron"])
        | (ct == "CB0701")
        | (ann["root_id"] == SHIU_MN9),
        "root_id",
    ]
    bitter = ann.loc[sub.str.contains("bitter", case=False, na=False), "root_id"]
    pam = ann.loc[ct.str.startswith("PAM", na=False), "root_id"]
    ppl1 = ann.loc[ct.str.startswith("PPL1", na=False), "root_id"]
    dna02 = ann.loc[ct == "DNa02", "root_id"]
    dng13 = ann.loc[ct == "DNg13", "root_id"]
    npf = ann.loc[ct.str.contains("NPF", na=False) | syn.str.contains("NPF", na=False), "root_id"]
    epg = ann.loc[ct.str.startswith("EPG", na=False), "root_id"]
    pfl = ann.loc[ct.isin(["PFL2", "PFL3"]), "root_id"]
    fru = ann.loc[ann["fru_dsx"].astype(str).str.contains("fru", case=False, na=False), "root_id"]

    roles = {
        "sugar_grn": sugar.to_numpy(np.int64),
        "bitter_grn": bitter.to_numpy(np.int64),
        "feeding_mn": mn.to_numpy(np.int64),
        "pam": pam.to_numpy(np.int64),
        "ppl1": ppl1.to_numpy(np.int64),
        "dna02": dna02.to_numpy(np.int64),
        "dng13": dng13.to_numpy(np.int64),
        "npf": npf.to_numpy(np.int64),
        "epg": epg.to_numpy(np.int64),
        "pfl": pfl.to_numpy(np.int64),
        "fru": fru.to_numpy(np.int64),
    }
    for k, v in roles.items():
        print(f"  seed {k:12s} {len(v)}")
    return roles


def expand(con: pd.DataFrame, seeds: set[int], optic: set[int], hops: int = 2, min_syn: int = 5) -> set[int]:
    """Directed downstream expansion, skipping optic-lobe neurons."""
    keep = set(seeds)
    frontier = set(seeds)
    for h in range(hops):
        chunk = con[con["Presynaptic_ID"].isin(frontier)]
        chunk = chunk[chunk["Connectivity"] >= min_syn]
        posts = set(chunk["Postsynaptic_ID"].astype(np.int64)) - optic
        new = posts - keep
        print(f"  hop {h+1}: +{len(new)} (frontier was {len(frontier)})")
        keep |= posts
        frontier = new
        if not frontier:
            break
    return keep


def main() -> None:
    print("Loading annotations…")
    ann = pd.read_csv(DATA / "flywire_annotations.tsv", sep="\t", low_memory=False)
    ann["root_id"] = ann["root_id"].astype(np.int64)

    print("Loading Shiu connectivity (v783)…")
    con = pd.read_parquet(DATA / "Connectivity_783.parquet")

    optic = set(ann.loc[ann["super_class"] == "optic", "root_id"].astype(np.int64))
    print(f"  optic excluded from hops: {len(optic)}")

    print("Selecting hub seeds…")
    roles = select_seeds(ann)
    seeds = set().union(*[set(v.tolist()) for k, v in roles.items() if k != "fru"])

    print("Expanding sugar GRNs 3 hops (SEZ → more of the feeding transform)…")
    keep = expand(con, set(roles["sugar_grn"].tolist()), optic, hops=3, min_syn=6)

    print("Expanding bitter GRNs 2 hops…")
    keep |= expand(con, set(roles["bitter_grn"].tolist()), optic, hops=2, min_syn=5)

    print("Expanding PAM/PPL1/CX 2 hops (pulls Kenyon cells DANs actually hit)…")
    extra = set().union(
        set(roles["pam"].tolist()),
        set(roles["ppl1"].tolist()),
        set(roles["dna02"].tolist()),
        set(roles["npf"].tolist()),
        set(roles["feeding_mn"].tolist()),
        set(roles["epg"].tolist()),
        set(roles["pfl"].tolist()),
        set(roles["dng13"].tolist()),
    )
    keep |= expand(con, extra, optic, hops=2, min_syn=8)
    # fru/dsx cells only if they already landed in the motif — do not seed all 3k.
    keep |= seeds

    print(f"Subgraph neurons: {len(keep)}")
    edges = con[con["Presynaptic_ID"].isin(keep) & con["Postsynaptic_ID"].isin(keep)].copy()
    print(f"Subgraph edges: {len(edges)}")

    ids = np.array(sorted(keep), dtype=np.int64)
    idx = {int(i): n for n, i in enumerate(ids)}
    pre = edges["Presynaptic_ID"].map(idx).to_numpy(np.int32)
    post = edges["Postsynaptic_ID"].map(idx).to_numpy(np.int32)
    w = edges["Excitatory x Connectivity"].to_numpy(np.int16)

    meta = ann.set_index("root_id").reindex(ids)
    dim = meta["dimorphism"].fillna("isomorphic").astype(str).to_numpy()
    names = meta["cell_type"].fillna("").astype(str).to_numpy()
    nt = meta["top_nt"].fillna("").astype(str).to_numpy()
    side = meta["side"].fillna("").astype(str).to_numpy()

    role_mat = np.zeros((len(ids), len(roles)), dtype=np.uint8)
    role_names = np.array(list(roles.keys()), dtype=object)
    for j, key in enumerate(role_names):
        s = set(roles[key].tolist())
        for i, rid in enumerate(ids):
            if int(rid) in s:
                role_mat[i, j] = 1

    # Male instance: drop female-specific cells (MaleCNS mapping / Berg 2026).
    female_only = np.array(
        ["female-specific" in d or "potentially female-specific" in d for d in dim]
    )
    male_keep = ~female_only
    print(f"Female-specific dropped for male: {int(female_only.sum())}")

    # MaleCNS census for the HUD (types, not extra edges).
    male_ann = pd.read_feather(DATA / "male_body_annotations.feather")
    male_types = set(male_ann["type"].dropna().astype(str)) | set(
        male_ann["flywireType"].dropna().astype(str)
    )
    in_male = np.array([n in male_types for n in names])

    out = DATA / "brains.npz"
    np.savez_compressed(
        out,
        ids=ids,
        pre=pre,
        post=post,
        w_signed=w,
        dimorphism=dim.astype("U48"),
        names=names.astype("U48"),
        top_nt=nt.astype("U24"),
        side=side.astype("U12"),
        role_names=role_names.astype("U24"),
        role_mat=role_mat,
        male_mask=male_keep,
        type_in_malecns=in_male,
        shiu_mn9=np.int64(SHIU_MN9),
        n_edges=np.int64(len(edges)),
        hops="sugar×3 + bitter×2 + PAM/CX×2",
    )
    print(f"Wrote {out}  ({out.stat().st_size/1e6:.1f} MB)")


if __name__ == "__main__":
    main()
