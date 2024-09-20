---
slug: electrobun
title: Meet Electrobun
authors: yoav
tags: [electrobun]
---

Earlier this year I was just wrapping up a beta of [co(lab)](https://colab.sh) a hybrid web browser + code editor for deep work. Mostly written in Typescript, SolidJS, and Tailwind. I'd been building it in Electron and after figuring out how to get code signing and notarization working, how to distribute it and so on I ended up with a distributable that was 80MB+ compressed.

I'd added an update mechanism as well (from yet another separate project) that was supposed to be the gold standard that uses blockmap technology. This segments your next version into blocks and lets you only download the blocks you need when an update is available. It does this on the uncompressed version of your app which in my case was over 150MB+. However if you happen to make a change that affects a part of your app at the beginning, even if it's only a single character, then all the blocks will shift with different checksums meaning each of your users will likely have to download almost 150MB.

I started multiplying 150MB by the number of users and multiplying that by the number of times I wanted to ship an update. I wanted to ship like the web—continuously—but the sheer amount of data I would have to distribute with every small app change was obsene. I'm bootstrapping [Blackboard](https://blackboard.sh) and I found myself having to hold back on updates and ship less frequently to avoid spending hundreds of dollars in S3/Cloudfront bandwith costs.

I had been kicking around the idea of building an Electron alternative with [Bun](https://bun.sh) since long before Bun hit their 1.0.0 and having to second guess how often I ship while trying to bootstrap a startup lab was just the motivation I needed.

So I picked up zig, C, C++, and Objc and got to work. Once I'd built enough functionality into Electrobun I ported co(lab) from Electron to Electrobun. The compressed distributable for the Electrobun version of co(lab) is only 18MB. That's more than a 4x reduction, but I wasn't satisfied with that. I ported BSDIFF from C to zig, optimizing it for speed with SIMD and some other tricks I came up with and added a built-in update mechanism in Electrobun. Now when users download updates they only need to download a patch file. A small copy change now generates a 14KB patch file. So from up to 150MB with Electron's blockmaps to 14KB patch file that's a 95% reduction in the size of updates.

After 20 years at small startups and unicorns, and spending so much time earlier in my career with Adobe Flex/AIR, being able to ship desktop apps in Typescript with a batteries included framework at the speed of the web is just the thing I've always wanted.

Next steps for Electrobun are to upgrade the Bun and Zig versions, support distributing your apps to Windows and Linux, and enable more functionality like shipping a cross-platform web renderer for developers that prioritize rendering consistency over initial download size, instead of relying on the default setting of using system's webview.

Technically Electrobun is the first thing I'm shipping from my startup lab [Blackboard](https://blackboard.sh). I hope you like it as much as I do.
