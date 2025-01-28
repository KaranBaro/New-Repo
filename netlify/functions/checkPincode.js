import fetch from "node-fetch";
import { getDistance } from "geolib";

async function getCoordinatesFromPincode(pincode) {
  const url = `https://nominatim.openstreetmap.org/search?postalcode=${pincode}&country=India&format=json`;

  try {
    const response = await fetch(url);
    const data = await response.json();

   
    if (data.length > 0) {
      const { lat, lon } = data[0];
      return { latitude: parseFloat(lat), longitude: parseFloat(lon) };
    }

    throw new Error("No coordinates found for the given pincode.");
  } catch (error) {
    console.error("Error fetching coordinates:", error);
    throw error;
  }
}

function findNearestLocation(userCoordinates, warehouseCoordinates) {
  let nearestLocation = null;
  let minDistance = Infinity;


  Object.entries(warehouseCoordinates).forEach(([pincode, coords]) => {
    const distance = getDistance(userCoordinates, coords);

    if (distance < minDistance) {
      minDistance = distance;
      nearestLocation = { pincode, coords };
    }
  });

  return nearestLocation;
}

export async function handler(event) {
  const { pincode, productId } = event.queryStringParameters;

  if (!pincode || !productId) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "Missing pincode or productId" }),
    };
  }

  const SHOPIFY_API_URL = "https://blue-city-store.myshopify.com/admin/api/2023-01/graphql.json";
  const SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY;
  const warehouseCoordinates = {
    "342001": { latitude: 26.2389, longitude: 73.0243 },
    "313001": { latitude: 24.598284, longitude: 73.724251 },
  };
  const warehouseLocationMap = {
    "Udaipur Warehouse": "313001",
    "Air force central school scheme Jodhpur": "342001",
  };

  const query = `
    query getProductById($productId: ID!) {
      product(id: $productId) {
        id
        title
        variants(first: 10) {
          edges {
            node {
              id
              title
              inventoryItem {
                inventoryLevels(first: 10) {
                  edges {
                    node {
                      location {
                        id
                        name
                      }
                      quantities(names: "available") {
                        quantity
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  `;

  try {
    const userCoordinates = await getCoordinatesFromPincode(pincode);
    console.debug("Coordinates:", userCoordinates, warehouseCoordinates);

    const response = await fetch(SHOPIFY_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": SHOPIFY_API_KEY,
      },
      body: JSON.stringify({ query, variables: { productId } }),
    });

    const result = await response.json();

    if (!response.ok) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: result.errors || "Error fetching product data" }),
      };
    }

    const product = result.data.product;

    if (!product) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: "Product not found" }),
      };
    }

    const inventoryLevels = product.variants.edges.flatMap((variant) =>
      variant.node.inventoryItem.inventoryLevels.edges.map((level) => ({
        locationName: level.node.location.name,
        quantity: level.node.quantities[0]?.quantity || 0,
      }))
    );

    const nearestLocation = findNearestLocation(userCoordinates, warehouseCoordinates);

    if (!nearestLocation) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: "No warehouse found near the provided pincode." }),
      };
    }

    const availableInventory = inventoryLevels.find(
      (level) =>
        warehouseLocationMap[level.locationName] === nearestLocation.pincode && // Match pincode
        level.quantity > 0 // Ensure stock is available
    );

    if (availableInventory) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          warehouse: availableInventory.locationName,
          quantity: availableInventory.quantity,
          message: `Product is available at ${availableInventory.locationName}.`,
        }),
      };
    }

    const fallbackInventory = inventoryLevels.find((level) => level.quantity > 0);

    if (fallbackInventory) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          warehouse: fallbackInventory.locationName,
          quantity: fallbackInventory.quantity,
          message: `Product is not available near your pincode but is available at ${fallbackInventory.locationName}.`,
        }),
      };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ error: "Product is out of stock at all locations." }),
    };
  } catch (error) {
    console.error("Error:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Server error" }),
    };
  }
}
