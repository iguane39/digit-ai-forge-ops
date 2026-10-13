# -*- coding: utf-8 -*-
"""Collecteur du kit Google Ads — LECTURE SEULE du compte, pose un relevé JSON (TF-1364).

C'est le SEUL morceau du kit qui parle à Google. Il ne juge rien : il lit le compte publicitaire par
l'API, en lecture seule, et écrit un relevé au schéma `forge-ops/google-ads-releve@1`, que
`google-ads.mjs releve` et `google-ads.mjs delta` jugent sans réseau. Toutes ses requêtes sont des
`search_stream` du service GoogleAdsService ; il n'appelle aucune méthode d'écriture.
`google-ads.mjs controler-collecteur` le vérifie à la lecture, et la recette de la forge le rejoue.

    uv run --with google-ads python scripts/google-ads/collecter-compte.py --prefixe "<PRÉFIXE> " --sortie <releve.json> [--config <google-ads.yaml>]

`uv run --with` prend la bibliothèque dans un environnement éphémère : rien n'est installé sur le
poste.

CONFIGURATION — hors de tout dépôt (le chemin par défaut : `~/.config/digit-ai/google-ads.yaml`, ou
la variable GOOGLE_ADS_CONFIGURATION_FILE_PATH) :
    json_key_file_path: <chemin de la clé du compte de service>
    customer_id: <identifiant à 10 chiffres du compte publicitaire>
    login_customer_id: <facultatif, identifiant à 10 chiffres d'un compte administrateur>
Aucun jeton de développeur : Google les a supprimés le 09/09/2026, le niveau d'accès appartient au
projet Google Cloud du compte de service (référentiel des intégrations du pilot). Le compte de
service reçoit un accès « Lecture seule » au compte publicitaire (Admin → Accès et sécurité →
Utilisateurs). Une configuration incomplète s'arrête en exit 2 AVANT tout appel à Google.

LA FENÊTRE DE DIFFUSION (TF-1585). LAST_30_DAYS exclut aujourd'hui, et une requête de métriques tait
les lignes à 0 impression : un relevé vert est sorti sur un compte muet le 24/09/2026. Ici, chaque
campagne est lue depuis sa date de départ jusqu'à aujourd'hui compris (borne explicite BETWEEN), et
sa diffusion est posée MÊME à 0. Les dates se disent dans le fuseau du compte.

Codes de sortie : 0 relevé écrit · 2 configuration incomplète ou usage · 3 erreur de l'API (le
message de Google est imprimé tel quel, tronqué à 2 000 caractères).
"""
import argparse
import datetime
import json
import os
import re
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

SCHEMA = "forge-ops/google-ads-releve@1"
FENETRE = "depuis_le_depart_aujourd_hui_compris"
CONFIG_DEFAUT = Path(os.environ.get("GOOGLE_ADS_CONFIGURATION_FILE_PATH",
                                    Path.home() / ".config" / "digit-ai" / "google-ads.yaml"))


def charger_client(chemin):
    """Rend (client, identifiant du compte) ou s'arrête en exit 2 en nommant la valeur manquante."""
    if not chemin.exists():
        print(f"CONFIGURATION ABSENTE : {chemin}")
        sys.exit(2)
    import yaml
    conf = yaml.safe_load(chemin.read_text(encoding="utf-8")) or {}
    cle = str(conf.get("json_key_file_path") or "").strip()
    client_id = re.sub(r"\D", "", str(conf.get("customer_id") or ""))
    login_id = re.sub(r"\D", "", str(conf.get("login_customer_id") or ""))
    manques = []
    if not cle or not Path(os.path.expandvars(cle)).expanduser().exists():
        manques.append("json_key_file_path — la clé du compte de service est introuvable")
    if len(client_id) != 10:
        manques.append("customer_id — l'identifiant à 10 chiffres du compte publicitaire")
    if login_id and len(login_id) != 10:
        manques.append("login_customer_id — l'identifiant à 10 chiffres du compte administrateur")
    if manques:
        print(f"CONFIGURATION INCOMPLÈTE ({chemin}) — {len(manques)} valeur(s) manquante(s) :")
        for m in manques:
            print(f"  · {m}")
        sys.exit(2)
    from google.ads.googleads.client import GoogleAdsClient
    reglages = {"use_proto_plus": True, "json_key_file_path": str(Path(os.path.expandvars(cle)).expanduser())}
    if conf.get("developer_token"):  # un ancien jeton n'est pas refusé : Google l'ignore depuis le 09/09/2026
        reglages["developer_token"] = str(conf["developer_token"])
    if login_id:
        reglages["login_customer_id"] = login_id
    return GoogleAdsClient.load_from_dict(reglages), client_id


def maintenant_compte(fuseau):
    try:
        from zoneinfo import ZoneInfo
        return datetime.datetime.now(ZoneInfo(fuseau)).replace(tzinfo=None)
    except Exception:
        return datetime.datetime.now()


def present(message, champ):
    """La valeur d'un champ facultatif, ou None s'il est absent : un « — » n'est pas un zéro."""
    try:
        return getattr(message, champ) if champ in message else None
    except TypeError:
        return getattr(message, champ, None)


def collecter(client, cid, prefixe):
    service = client.get_service("GoogleAdsService")
    if "'" in prefixe or "\\" in prefixe:
        print("PRÉFIXE REFUSÉ : ni apostrophe ni antislash (il entre tel quel dans la requête)")
        sys.exit(2)
    filtre = f"campaign.name LIKE '{prefixe}%' AND campaign.status != 'REMOVED'"

    def lignes(requete):
        for lot in service.search_stream(customer_id=cid, query=requete):
            yield from lot.results

    fuseau = next(iter(lignes("SELECT customer.time_zone FROM customer"))).customer.time_zone
    heure = maintenant_compte(fuseau)
    aujourdhui = heure.date().isoformat()
    campagnes = {}
    for r in lignes("SELECT campaign.id, campaign.name, campaign.status, campaign.serving_status, "
                    "campaign.start_date_time, campaign.bidding_strategy_type, "
                    "campaign.network_settings.target_partner_search_network, "
                    "campaign.network_settings.target_content_network, "
                    "campaign.geo_target_type_setting.positive_geo_target_type, campaign_budget.amount_micros "
                    f"FROM campaign WHERE {filtre}"):
        c = r.campaign
        campagnes[c.id] = {
            "nom": c.name, "id": str(c.id), "statut": c.status.name, "service": c.serving_status.name,
            "debut": c.start_date_time, "budget_jour": round(r.campaign_budget.amount_micros / 1e6, 2),
            "enchere": c.bidding_strategy_type.name,
            "partenaires": bool(c.network_settings.target_partner_search_network),
            "display": bool(c.network_settings.target_content_network),
            "option_zone": c.geo_target_type_setting.positive_geo_target_type.name,
            "lieux": 0, "langues": 0, "exclusions": [], "groupes": {},
        }
    for r in lignes("SELECT campaign.id, ad_group.id, ad_group.name, ad_group.cpc_bid_micros FROM ad_group "
                    f"WHERE {filtre} AND ad_group.status != 'REMOVED'"):
        if r.campaign.id in campagnes:
            campagnes[r.campaign.id]["groupes"][r.ad_group.id] = {
                "nom": r.ad_group.name, "id": str(r.ad_group.id),
                "cpc": round(r.ad_group.cpc_bid_micros / 1e6, 2), "mots": [], "annonces": []}
    for r in lignes("SELECT campaign.id, ad_group.id, ad_group_criterion.criterion_id, "
                    "ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type FROM ad_group_criterion "
                    "WHERE ad_group_criterion.type = 'KEYWORD' AND ad_group_criterion.negative = FALSE "
                    f"AND ad_group_criterion.status != 'REMOVED' AND {filtre}"):
        g = campagnes.get(r.campaign.id, {}).get("groupes", {}).get(r.ad_group.id)
        if g is not None:
            k = r.ad_group_criterion.keyword
            g["mots"].append({"texte": k.text, "correspondance": k.match_type.name,
                              "id": str(r.ad_group_criterion.criterion_id)})
    for r in lignes("SELECT campaign.id, ad_group.id, ad_group_ad.policy_summary.review_status FROM ad_group_ad "
                    f"WHERE ad_group_ad.status != 'REMOVED' AND {filtre}"):
        g = campagnes.get(r.campaign.id, {}).get("groupes", {}).get(r.ad_group.id)
        if g is not None:
            g["annonces"].append({"statut_examen": r.ad_group_ad.policy_summary.review_status.name})
    for r in lignes("SELECT campaign.id, campaign_criterion.type, campaign_criterion.negative, "
                    "campaign_criterion.criterion_id, campaign_criterion.keyword.text, "
                    "campaign_criterion.keyword.match_type FROM campaign_criterion "
                    f"WHERE campaign_criterion.status != 'REMOVED' AND {filtre}"):
        c = campagnes.get(r.campaign.id)
        if c is None:
            continue
        cc = r.campaign_criterion
        t = cc.type_.name
        if t == "KEYWORD" and cc.negative:
            c["exclusions"].append({"texte": cc.keyword.text, "correspondance": cc.keyword.match_type.name,
                                    "id": str(cc.criterion_id)})
        elif t == "LOCATION" and not cc.negative:
            c["lieux"] += 1
        elif t == "LANGUAGE":
            c["langues"] += 1
    conversions = [{"nom": r.conversion_action.name, "statut": r.conversion_action.status.name,
                    "principale": bool(r.conversion_action.primary_for_goal)}
                   for r in lignes("SELECT conversion_action.name, conversion_action.status, "
                                   "conversion_action.primary_for_goal FROM conversion_action")]
    # La diffusion de CHAQUE campagne, depuis son départ, aujourd'hui compris — posée à 0 d'abord :
    # une requête de métriques ne rend aucune ligne pour une campagne muette.
    for cid_campagne, c in campagnes.items():
        d = {"impressions": 0, "clics": 0, "cout": 0.0, "parts": {"obtenue": None}}
        c["diffusion"] = d
        debut = (c["debut"] or "")[:10]
        if not debut or debut > aujourdhui:
            continue
        for r in lignes("SELECT metrics.impressions, metrics.clicks, metrics.cost_micros, "
                        "metrics.search_impression_share FROM campaign "
                        f"WHERE campaign.id = {int(cid_campagne)} AND segments.date BETWEEN '{debut}' AND '{aujourdhui}'"):
            d["impressions"] += r.metrics.impressions
            d["clics"] += r.metrics.clicks
            d["cout"] = round(d["cout"] + r.metrics.cost_micros / 1e6, 2)
            part = present(r.metrics, "search_impression_share")
            if part is not None:
                d["parts"]["obtenue"] = part
    sortie = []
    for c in campagnes.values():
        c["groupes"] = list(c["groupes"].values())
        sortie.append(c)
    return {"schema": SCHEMA, "fenetre_diffusion": FENETRE, "lu_le": heure.isoformat(timespec="minutes"),
            "fuseau": fuseau, "aujourdhui": aujourdhui, "prefixe": prefixe,
            "campagnes": sortie, "conversions": conversions}


def main():
    p = argparse.ArgumentParser(description="Relevé en lecture seule d'un compte Google Ads (kit forge-ops)")
    p.add_argument("--prefixe", required=True, help="préfixe commun des campagnes du plan")
    p.add_argument("--sortie", required=True, help="fichier JSON du relevé")
    p.add_argument("--config", default=str(CONFIG_DEFAUT), help="fichier YAML hors dépôt")
    a = p.parse_args()
    client, cid = charger_client(Path(a.config))
    try:
        releve = collecter(client, cid, a.prefixe)
    except SystemExit:
        raise
    except Exception as ex:  # GoogleAdsException et erreurs de transport : le message de Google, tel quel
        print(f"ERREUR DE L'API : {type(ex).__name__}")
        print(str(ex)[:2000])
        sys.exit(3)
    Path(a.sortie).write_text(json.dumps(releve, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"relevé écrit : {a.sortie} — {len(releve['campagnes'])} campagne(s) « {a.prefixe}… », lu le {releve['lu_le']} ({releve['fuseau']})")


if __name__ == "__main__":
    main()
