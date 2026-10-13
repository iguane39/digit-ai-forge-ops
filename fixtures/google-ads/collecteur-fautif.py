# -*- coding: utf-8 -*-
# Collecteur FAUTIF de la recette : il reproduit les deux défauts que le contrôle du collecteur refuse.
# 1. sa seule requête de métriques lit LAST_30_DAYS, qui exclut aujourd'hui (relevé vert sur un
#    compte muet, 24/09/2026) ;
# 2. il appelle une méthode d'écriture : un collecteur n'écrit jamais dans le compte.


def collecter(client, cid):
    service = client.get_service("GoogleAdsService")
    requete = ("SELECT campaign.name, metrics.impressions FROM campaign "
               "WHERE segments.date DURING LAST_30_DAYS")
    lignes = [r for lot in service.search_stream(customer_id=cid, query=requete) for r in lot.results]
    budget = client.get_service("CampaignBudgetService")
    budget.mutate_campaign_budgets(customer_id=cid, operations=[])
    return lignes
