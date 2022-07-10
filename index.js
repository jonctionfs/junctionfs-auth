require("dotenv").config()

const express = require("express")
const cors = require("cors")
const helmet = require("helmet")
const httpProxy = require('http-proxy')
const multer = require('multer')
const fetch = require('node-fetch')

const supertokens = require("supertokens-node")
const Session = require("supertokens-node/recipe/session")
const UserMetadata = require("supertokens-node/recipe/usermetadata")
const { verifySession } = require("supertokens-node/recipe/session/framework/express")
const { middleware, errorHandler } = require("supertokens-node/framework/express")
const ThirdPartyEmailPassword = require("supertokens-node/recipe/thirdpartyemailpassword")

const apiProxy = httpProxy.createProxyServer()

const apiPort = process.env.API_PORT || 3001
const apiDomain = process.env.API_DOMAIN + apiPort
const websiteDomain = process.env.WEBSITE_DOMAIN

const jonctionfsUri = process.env.JONCTIONFS_URI

let google = ThirdPartyEmailPassword.Google({
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    scope: ["https://www.googleapis.com/auth/drive", "https://www.googleapis.com/auth/userinfo.email"],
});

const storage = multer.memoryStorage()
const upload = multer({ dest: 'uploads/', storage })

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
                                let googleServiceData = await getServiceData(response.user.id, "Google Drive")
                                if (!googleServiceData) {
                                    await addService(response.user.id, "Google Drive", "GoogleDrive", response.authCodeResponse)
                                } else {
                                    await editService(response.user.id, "Google Drive", response.authCodeResponse)
                                }
                            }
                            return response
                        },
                    }
                }
            }
        }),
        Session.init(),
        UserMetadata.init(),

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

app.post("/upload/google-drive/*", upload.single('Media'), async (req, res) => {
    const googleUrl = req.url.substring(21)

    const googleRes = fetch(googleUrl, {
        method: "PUT",
        headers: {
            "Content-Length": req.headers["content-length"]
        },
        body: req.file.buffer
    })

    res.status((await googleRes).status).end()
})

app.get("/auth/logout", verifySession({sessionRequired: process.env.DISABLE_AUTH !== "true"}), async (req, res) => {
    await req.session.revokeSession()
    res.send("Success! User session revoked")
})

app.get("/auth/callback/google", async (req, res) => {
    res.redirect(process.env.WEBSITE_DOMAIN + "/#" + req.url)
})

app.get("/api/*", verifySession({sessionRequired: process.env.DISABLE_AUTH !== "true"}), async (req, res) => {
    const userId = req.session?.getUserId()

    const services = await getServices(userId)
    const servicesNames = services?.map(x => { return {name: x.name, type: x.type}})

    res.json(servicesNames)
})

app.put("/api/*", verifySession({sessionRequired: process.env.DISABLE_AUTH !== "true"}), express.json(), async (req, res) => {
    const name = req.body.name
    const type = req.body.type
    const data = req.body.data

    addService(userId, name, type, data)

    res.status(201).end()
})

const addService = async (userId, name, type, data) => {
    let services = await getServices(userId)

    const existingService = await getServiceData(userId, name)

    if (!!existingService) {
        throw "Trying to add a service which already exists"
    }

    if (!services?.length) {
        services = []
    }

    services.push({name, type, data})

    await UserMetadata.updateUserMetadata(userId, { services });

}

const editService = async (userId, name, data) => {
    const services = await getServices(userId)
    const serviceIndex = services.findIndex(x => x.name == name)
    services[serviceIndex].data = data
    await UserMetadata.updateUserMetadata(userId, { services });
}

const getServiceData = async (userId, name) => {
    const services = await getServices(userId)
    if (!services) {
        return null
    }
    return services.find(x => x.name == name)
}

const getServices = async (userId) => {
    let { metadata } = await UserMetadata.getUserMetadata(userId)

    // Temporary fix since sometimes the services becomes a number
    if (typeof metadata.services == "number") {
        console.warn("services was a number. Updating to an array")
        UserMetadata.updateUserMetadata(userId, { services: [] })
        metadata = (await UserMetadata.getUserMetadata(userId)).metadata;
    }

    return metadata.services
}

app.all("/api/*", verifySession({sessionRequired: process.env.DISABLE_AUTH !== "true"}), async (req, res) => {
    try {
        const userId = req.session?.getUserId()
        req.headers["authenticated-user"] = userId || "My-username"

        const providerId = req.headers["provider-id"]
        const providerInfo = await getServiceData(userId, providerId)

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