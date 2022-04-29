require("dotenv").config()

const express = require("express")
const cors = require("cors")
const helmet = require("helmet")
const httpProxy = require('http-proxy')
const redis = require('redis')

const supertokens = require("supertokens-node")
const Session = require("supertokens-node/recipe/session")
const { verifySession } = require("supertokens-node/recipe/session/framework/express")
const { middleware, errorHandler } = require("supertokens-node/framework/express")
const ThirdPartyEmailPassword = require("supertokens-node/recipe/thirdpartyemailpassword")
const { Google } = ThirdPartyEmailPassword

const apiProxy = httpProxy.createProxyServer()

const apiPort = process.env.API_PORT || 3001
const apiDomain = process.env.API_DOMAIN + apiPort
const websiteDomain = process.env.WEBSITE_DOMAIN

const jonctionfsUri = process.env.JONCTIONFS_URI

const client = redis.createClient({
    url: process.env.REDIS_URL
})

client.connect().catch(err => {
    console.error("Unable to connect to redis", err)
})

let google = ThirdPartyEmailPassword.Google({
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    scope: ["https://www.googleapis.com/auth/drive", "https://www.googleapis.com/auth/userinfo.email"],
});

supertokens.init({
    framework: "express",
    supertokens: {
        connectionURI: process.env.SUPERTOKENS_CONNECTION_URI,
        apiKey: process.env.SUPERTOKENS_API_KEY
    },
    appInfo: {
        appName: process.env.APP_NAME || "ThinkDrive",
        apiDomain,
        websiteDomain,
        apiBasePath: process.env.AUTH_BASE_PATH,
        websiteBasePath: process.env.WEBSITE_AUTH_BASE_PATH
    },
    recipeList: [
        ThirdPartyEmailPassword.init({
            providers: [
                {
                    ...google,
                    get: function (redirectURI, authCodeFromRequest, userContext) {
                        let getResult = google.get(redirectURI, authCodeFromRequest, userContext);
                        return {
                            ...getResult,
                            getProfileInfo: async function (authCodeResponse, userContext) {
                                try {
                                    return await getResult.getProfileInfo(authCodeResponse, userContext);
                                } catch (err) {
                                    console.error(err);
                                    throw err;
                                }
                            }
                        }
                    }
                }
            ],
            override: {
                apis: (originalImplementation) => {
                    return {
                        ...originalImplementation,
                        thirdPartySignInUpPOST: async function(input) {
                            if (originalImplementation.thirdPartySignInUpPOST === undefined) {
                                throw Error("Should never come here")
                            }

                            input.clientId = process.env.GOOGLE_CLIENT_ID
                            
                            let response
                            try {
                                response = await originalImplementation.thirdPartySignInUpPOST(input)
                            } catch(e) {
                                console.error(e)
                            }

                            if (response.status === "OK") {
                                client.set(response.user.id + '_Google Drive_GoogleDrive', JSON.stringify({data: response.authCodeResponse}), (err, reply) => {
                                    if (err) console.error(err)
                                });
                            }
                            return response
                        },
                    }
                }
            }
        }),
        Session.init(),
    ],
})

const app = express()

app.use(
    cors({
        origin: apiDomain,
        allowedHeaders: ["content-type", "action", "data-source", "user", "api", ...supertokens.getAllCORSHeaders()],
        methods: ["GET", "PUT", "POST", "DELETE"],
        credentials: true,
    })
)

app.use(
    helmet({
        contentSecurityPolicy: false,
    })
)

app.use(middleware())

app.get("/auth/logout", verifySession({sessionRequired: process.env.DISABLE_AUTH !== "true"}), async (req, res) => {
    await req.session.revokeSession()
    res.send("Success! User session revoked")
})

app.get("/auth/callback/google", async (req, res) => {
    res.redirect(process.env.WEBSITE_DOMAIN + "/#" + req.url)
})

app.get("/api/*", verifySession({sessionRequired: process.env.DISABLE_AUTH !== "true"}), async (req, res) => {
    const userId = req.session?.getUserId()
    const keys = await client.sendCommand(['KEYS','*'])
    const connections = keys.filter((x) => x.startsWith(userId)).map((x) => {
        const start = x.indexOf('_') + 1
        const end = x.lastIndexOf('_')
        return {
            id: x.substring(start, end),
            type: x.substring(end+1)
        }
    })

    res.json(connections)
})

app.put("/api/*", verifySession({sessionRequired: process.env.DISABLE_AUTH !== "true"}), express.json(), async (req, res) => {
    const name = req.body.name
    const type = req.body.type
    const data = req.body.data
    const connectionName = req.session?.getUserId() + '_' + name + '_' + type
    const existingEntry = await client.get(connectionName)

    if (!!existingEntry) {
        return new Response('A service with the name name already exists', { status: 400 })
    }

    client.set(connectionName, JSON.stringify({
        name,
        data
    }))

    res.status(201).end()
})

app.all("/api/*", verifySession({sessionRequired: process.env.DISABLE_AUTH !== "true"}), async (req, res) => {
    try {
        const userId = req.session?.getUserId()
        req.headers["authenticated-user"] = userId || "My-username"

        const providerId = req.headers["provider-id"]
        const providerType = req.headers["provider-type"]
        const connectionName = userId + '_' + providerId + '_' + providerType
        const providerInfo = JSON.parse(await client.get(connectionName))

        req.headers["provider-credentials"] = JSON.stringify(providerInfo.data)

        apiProxy.web(req, res, {target: jonctionfsUri})
    } catch (err) {
        console.error(err)
        res.status(500).end()
    }
})

app.get("/*", (req, res) => {
    try {
        apiProxy.web(req, res, {target: process.env.WEBSITE_URL})
    } catch (err) {
        console.error(err)
        res.status(500).end()
    }
})

app.use(errorHandler())

app.use((err, _req, res, _next) => {
    console.error(err)
    res.status(500).send("Internal error: " + err.message)
})

app.listen(apiPort, () => console.info(`API Server listening on port ${apiPort}`))