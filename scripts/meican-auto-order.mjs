import { readFileSync } from "node:fs";

const RULES = loadRules();

const CONFIG = {
  username: mustEnv("MEICAN_USERNAME"),
  password: mustEnv("MEICAN_PASSWORD"),
  defaultPickupLocation: process.env.DEFAULT_PICKUP_LOCATION || RULES.defaultPickupLocation || "汇金A座62楼",
  dryRun: (process.env.DRY_RUN || "false").toLowerCase() === "true",
  targetDateOverride: process.env.TARGET_DATE || "",
  clientId: "Xqr8w0Uk4ciodqfPwjhav5rdxTaYepD",
  clientSecret: "vD11O6xI9bG3kqYRu9OyPAHkRGxLh4E",
};

const MEALS = [
  {
    key: "breakfast",
    label: "早餐",
    budgetInCent: mealConfig("breakfast").budgetInCent,
    titlePattern: /早餐/,
    dishAllowed: (dish) => dishAllowedByConfig(dish, mealConfig("breakfast")),
    restaurantAllowed: (restaurant) => restaurantAllowedByConfig(restaurant, mealConfig("breakfast")),
  },
  {
    key: "lunch",
    label: "午餐",
    budgetInCent: mealConfig("lunch").budgetInCent,
    titlePattern: /午餐/,
    dishAllowed: (dish) => dishAllowedByConfig(dish, mealConfig("lunch")),
    restaurantAllowed: (restaurant) => restaurantAllowedByConfig(restaurant, mealConfig("lunch")),
  },
  {
    key: "dinner",
    label: "晚餐",
    budgetInCent: mealConfig("dinner").budgetInCent,
    titlePattern: /晚餐/,
    dishAllowed: (dish) => dishAllowedByConfig(dish, mealConfig("dinner")),
    restaurantAllowed: (restaurant) => restaurantAllowedByConfig(restaurant, mealConfig("dinner")),
  },
];

let token = null;

main().catch((error) => {
  console.error(`Failed: ${error.message}`);
  process.exitCode = 1;
});

async function main() {
  const onlineDate = await getOnlineChinaDate();
  const targetDate = CONFIG.targetDateOverride || getTargetDate(onlineDate);

  console.log(`Online Beijing date: ${onlineDate.date} ${onlineDate.weekdayLabel}`);

  if (!targetDate) {
    console.log("Skip: today is not an ordering day.");
    return;
  }

  console.log(`Target date: ${targetDate}`);
  if (CONFIG.dryRun) {
    console.log("Dry run: no orders will be submitted.");
  }

  await login();
  const calendarItems = await getCalendarItems(targetDate);
  const results = [];

  for (const mealRule of MEALS) {
    const calendarItem = calendarItems.find((item) => mealRule.titlePattern.test(item.title || ""));
    if (!calendarItem) {
      results.push({ meal: mealRule.label, status: "SKIPPED", reason: "No meal calendar item found." });
      continue;
    }

    if (calendarItem.status === "ORDER") {
      results.push({ meal: mealRule.label, status: "EXISTS", title: calendarItem.title });
      continue;
    }

    if (calendarItem.status && calendarItem.status !== "AVAILABLE") {
      results.push({ meal: mealRule.label, status: "SKIPPED", title: calendarItem.title, reason: calendarItem.status });
      continue;
    }

    const selected = await selectDish(calendarItem, mealRule);
    if (!selected) {
      results.push({ meal: mealRule.label, status: "SKIPPED", title: calendarItem.title, reason: "No matching dish." });
      continue;
    }

    const address = await getPickupAddress(calendarItem);
    if (!address) {
      results.push({ meal: mealRule.label, status: "SKIPPED", title: calendarItem.title, reason: "No pickup address found." });
      continue;
    }

    if (CONFIG.dryRun) {
      results.push({
        meal: mealRule.label,
        status: "DRY_RUN",
        title: calendarItem.title,
        restaurant: selected.restaurant.name,
        dish: selected.dish.name,
        price: money(selected.dish.priceInCent),
        pickup: address.pickUpLocation,
      });
      continue;
    }

    const order = await addOrder(calendarItem, selected.dish, address);
    results.push({
      meal: mealRule.label,
      status: "ORDERED",
      title: calendarItem.title,
      restaurant: selected.restaurant.name,
      dish: selected.dish.name,
      price: money(selected.dish.priceInCent),
      pickup: address.pickUpLocation,
      orderUniqueId: order.order?.uniqueId,
    });
  }

  console.log(JSON.stringify(results, null, 2));
}

function mustEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

function loadRules() {
  const url = new URL("../config/rules.json", import.meta.url);
  return JSON.parse(readFileSync(url, "utf8"));
}

function mealConfig(key) {
  return RULES.meals?.[key] || {};
}

function dishAllowedByConfig(dish, config) {
  const text = dish.name || "";
  if (config.requiredAny?.length && !hasAny(text, config.requiredAny)) return false;
  if (config.forbiddenAny?.length && hasAny(text, config.forbiddenAny)) return false;
  if (config.avoidSpicy && isSpicy(text)) return false;
  return true;
}

function restaurantAllowedByConfig(restaurant, config) {
  const forbidden = config.forbiddenRestaurants || [];
  return !forbidden.some((name) => restaurant.name.includes(name));
}

async function getOnlineChinaDate() {
  const response = await fetch("https://meican.com", { method: "HEAD", cache: "no-store" });
  const dateHeader = response.headers.get("date");
  if (!dateHeader) throw new Error("Unable to confirm online date.");

  const date = new Date(dateHeader);
  if (Number.isNaN(date.getTime())) throw new Error("Unable to parse online date.");

  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "short",
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value])
  );

  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: parts.weekday,
    weekdayLabel: weekdayLabel(parts.weekday),
  };
}

function getTargetDate(onlineDate) {
  const offsetByWeekday = {
    Mon: 1,
    Tue: 1,
    Wed: 1,
    Thu: 1,
    Sat: 2,
  };
  const offset = offsetByWeekday[onlineDate.weekday];
  if (!offset) return "";

  const [year, month, day] = onlineDate.date.split("-").map(Number);
  const utcNoon = Date.UTC(year, month - 1, day, 12);
  const target = new Date(utcNoon + offset * 24 * 60 * 60 * 1000);
  return target.toISOString().slice(0, 10);
}

function weekdayLabel(shortName) {
  return {
    Mon: "星期一",
    Tue: "星期二",
    Wed: "星期三",
    Thu: "星期四",
    Fri: "星期五",
    Sat: "星期六",
    Sun: "星期日",
  }[shortName] || shortName;
}

async function login() {
  const body = new URLSearchParams({
    username: CONFIG.username,
    password: CONFIG.password,
    grant_type: "password",
    username_type: "username",
    meican_credential_type: "password",
    x: "true",
  });

  const data = await api("oauth/token", { method: "POST", auth: false, body });
  if (!data.access_token) throw new Error(`Login failed: ${data.error_description || data.error || "unknown error"}`);

  token = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    tokenType: data.token_type || "bearer",
  };
}

async function getCalendarItems(targetDate) {
  const data = await api("calendarItems/list", {
    params: {
      withOrderDetail: "false",
      beginDate: targetDate,
      endDate: targetDate,
    },
  });
  return data?.dateList?.[0]?.calendarItemList || [];
}

async function selectDish(calendarItem, mealRule) {
  const targetTime = formatShanghai(calendarItem.targetTime);
  const restaurantsData = await api("restaurants/list", {
    params: {
      tabUniqueId: calendarItem.userTab.uniqueId,
      targetTime,
    },
  });
  const restaurants = restaurantsData.restaurantList || [];

  for (const restaurant of restaurants) {
    if (!restaurant.open || !mealRule.restaurantAllowed(restaurant)) continue;

    const detail = await api("restaurants/show", {
      params: {
        restaurantUniqueId: restaurant.uniqueId,
        tabUniqueId: calendarItem.userTab.uniqueId,
        targetTime,
      },
    });

    const dishes = (detail.dishList || []).filter((dish) => !dish.isSection);
    const dish = dishes.find((candidate) => {
      if (candidate.available === false || candidate.soldOut) return false;
      if (mealRule.budgetInCent !== null && candidate.priceInCent > mealRule.budgetInCent) return false;
      return mealRule.dishAllowed(candidate);
    });

    if (dish) return { restaurant, dish };
  }

  return null;
}

async function getPickupAddress(calendarItem) {
  const namespace = calendarItem.userTab?.corp?.namespace || calendarItem.namespace;
  if (!namespace) return null;

  const data = await api("corpaddresses/getmulticorpaddress", { params: { namespace } });
  const addressData = data.data || data;

  const recent = addressData.recentList || [];
  const recentMatch = recent.find((item) => item.pickUpLocation === CONFIG.defaultPickupLocation);
  if (recentMatch) return recentMatch;

  for (const address of addressData.addressList || []) {
    if (address.name === CONFIG.defaultPickupLocation && address.finalValue) return address.finalValue;
  }

  return recent[0] || addressData.addressList?.[0]?.finalValue || null;
}

async function addOrder(calendarItem, dish, address) {
  const targetTime = formatShanghai(calendarItem.targetTime);
  const data = await api("orders/add", {
    method: "POST",
    body: new URLSearchParams({
      tabUniqueId: calendarItem.userTab.uniqueId,
      order: JSON.stringify([{ count: 1, dishId: dish.id }]),
      remarks: JSON.stringify(null),
      targetTime,
      userAddressUniqueId: address.uniqueId,
      corpAddressUniqueId: address.uniqueId,
      corpAddressRemark: address.remark || "",
    }),
  });

  if (data.status !== "SUCCESSFUL") {
    throw new Error(`Order failed for ${calendarItem.title}: ${data.message || data.status || JSON.stringify(data)}`);
  }

  return data;
}

async function api(path, options = {}) {
  const method = options.method || "GET";
  const auth = options.auth !== false;
  const url = new URL(path, "https://meican.com/forward/api/v2.1/");

  const params = {
    client_id: CONFIG.clientId,
    client_secret: CONFIG.clientSecret,
    ...(options.params || {}),
  };
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }

  const headers = {
    accept: "application/json, text/plain, */*",
    "accept-language": "zh",
    "user-agent": "Mozilla/5.0",
    clientId: CONFIG.clientId,
    clientSecret: CONFIG.clientSecret,
  };

  if (auth) {
    if (!token?.accessToken) throw new Error(`Missing token for ${path}`);
    headers.Authorization = `Bearer ${token.accessToken}`;
  }

  let body = options.body;
  if (body instanceof URLSearchParams) {
    headers["content-type"] = "application/x-www-form-urlencoded";
  }

  const response = await fetch(url, { method, headers, body });
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    throw new Error(`${path} returned ${response.status}: ${data.error_description || data.error || text.slice(0, 200)}`);
  }

  return data;
}

function formatShanghai(timestamp) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("sv-SE", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    })
      .formatToParts(new Date(timestamp))
      .map((part) => [part.type, part.value])
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

function isSpicy(text) {
  return hasAny(text, RULES.spicyWords || []);
}

function hasAny(text, words) {
  return words.some((word) => text.includes(word));
}

function money(priceInCent) {
  return `${(priceInCent / 100).toFixed(2)} 元`;
}
