---
sidebar_position: 4
title: Code Signing
sidebar_label: Code Signing
---

## Mac
Apple often ships machines with expired certificates which is a huge pain. You can easily end up in a loop of generating certificates in the developer portal, installing them, and seeing the certificate is not trusted. 

You can avoid a lot of headaches by installing the full Xcode via the app store. Open XCode, click the app menu and the Settings. Go to the Accounts tab and add your developer account. Click "Manage Certificates". Then click the + sign and add a "Developer ID Application" certificate. If you open Keychain Access you should be able to see it if you search the Login keychain for "Developer ID Application". You can also log into the Apple Developer portal and look at your certificates and you'll see it there as well.

Now in the developer portal go to Identifiers and click the plus sign to add one for your app. Make sure "App Attest" is checked so Electrobun's CLI can code sign and notarize your app. You may need other services if you need them.

Now in another tab outside the Apple developer portal log into your apple account https://account.apple.com/sign-in. Go to "App Specific Passwords" and Create one for your Electrobun usage, this will be your `ELECTROBUN_APPLEIDPASS` that the Electrobun CLI will use to notarize your apps.

Now we need to get some values that you will add to your .zshrc file. Here is the mapping of those values and where to find them


```
ELECTROBUN_DEVELOPER_ID: In Apple Dev Portal open the certificate you created. The certificate name (probably your company name). eg: "My Corp Inc."

ELECTROBUN_TEAMID: In the Apple Dev Portal open the App Identifier you created for your app. Under "App ID Prefix" you'll see something like "BGU899NB8T (Team ID)" it's the "BGU899NB8T" part.

ELECTROBUN_APPLEID: This is your apple id email address, likely your personal apple id email address

ELECTROBUN_APPLEIDPASS: This is the app specific password you created for Electrobun code signing

```

Now open your .zshrc file and add the following lines so that they're in your env

```
export ELECTROBUN_DEVELOPER_ID="ELECTROBUN_DEVELOPER_ID: My Corp Inc. (BGU899NB8T)"
export ELECTROBUN_TEAMID="BGU899NB8T"
export ELECTROBUN_APPLEID="myemail@email.com"
export ELECTROBUN_APPLEIDPASS="your-app-specific-password"

```

Now in your electrobun.config file make sure Build.mac.codesign and build.mac.notarize are set to true. eg:

```
{
    "build": {
        "mac": {
            "codesign": true,
            "notarize": true,
        }
    }
}
```

Restart your terminal. You can confirm your env is setup correctly by entering the following and hitting enter to see if it outputs the value in your .zshrc file. You may need to restart or add it to a different file if it doesn't.
```
echo $ELECTROBUN_TEAMID
```

The next time you build your app the Electrobun CLI will sign and notarize your app, then compress it into the self extractor and sign and notarize the self extractor for you.
