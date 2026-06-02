# Meican Auto Order

GitHub Actions cloud task for ordering Meican meals by API.

## Schedule

Runs at 12:05 China time on Monday, Tuesday, Wednesday, Thursday, and Saturday.

The script first checks online Beijing time before ordering:

- Monday orders Tuesday.
- Tuesday orders Wednesday.
- Wednesday orders Thursday.
- Thursday orders Friday.
- Saturday orders next Monday.
- Saturday also orders next Thursday lunch from `贪玩午市`, with a random dish.
- Friday and Sunday are skipped.

## Rules

- Breakfast: max 8 RMB, no egg, must include milk or soy milk.
- Lunch: no spicy dishes, no Yangguofu.
- Dinner: max 20 RMB, no spicy dishes, no Yangguofu.
- Extra Saturday lunch order: next Thursday lunch, restaurant must include `贪玩午市`, random dish.
- Monday to Friday meals should not repeat dishes within the same workweek.
- Pickup location: `汇金A座62楼`.
- If a meal already has an order, the script keeps it.

## GitHub Secrets

Create a private GitHub repository, then add these repository secrets:

- `MEICAN_USERNAME`: your Meican login email.
- `MEICAN_PASSWORD`: your Meican password.
- `FEISHU_WEBHOOK_URL`: optional Feishu custom bot webhook URL for completion notifications.
- `FEISHU_SECRET`: optional Feishu custom bot signing secret, if signing is enabled.

Do not put the password directly in the repository.

## Feishu Notification

When `FEISHU_WEBHOOK_URL` is set, the workflow sends a text message after ordering finishes. The message lists each meal's date, status, restaurant, dish, price, pickup location, and order id when available.

If Feishu bot signing is enabled, also set `FEISHU_SECRET`.

## Manual Run

In GitHub, open `Actions` -> `Meican Auto Order` -> `Run workflow`.

Use `dry_run=true` to preview without submitting orders.
