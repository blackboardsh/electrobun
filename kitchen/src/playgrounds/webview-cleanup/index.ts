import Electrobun, { Electroview } from "electrobun/view";

const bunny = document.getElementById("bunny") as HTMLDivElement;

const MAX_ROTATION = 25;
const SPRING = 0.08;
const DAMPING = 0.85;

let targetRotateX = 0;
let targetRotateY = 0;
let currentRotateX = 0;
let currentRotateY = 0;
let velocityX = 0;
let velocityY = 0;

const rpc = Electroview.defineRPC<any>({
	maxRequestTime: 5000,
	handlers: {
		requests: {},
		messages: {
			cursorMove: ({ screenX, screenY, winX, winY, winW, winH }) => {
				const centerX = winX + winW / 2;
				const centerY = winY + winH / 2;

				const normalizedX = (screenX - centerX) / (winW / 2);
				const normalizedY = (screenY - centerY) / (winH / 2);

				const clampedX = Math.max(-1, Math.min(1, normalizedX));
				const clampedY = Math.max(-1, Math.min(1, normalizedY));

				targetRotateX = -clampedY * MAX_ROTATION;
				targetRotateY = clampedX * MAX_ROTATION;
			},
		},
	},
});

const electrobun = new Electrobun.Electroview({ rpc });

function animate() {
	const forceX = (targetRotateX - currentRotateX) * SPRING;
	const forceY = (targetRotateY - currentRotateY) * SPRING;

	velocityX = (velocityX + forceX) * DAMPING;
	velocityY = (velocityY + forceY) * DAMPING;

	currentRotateX += velocityX;
	currentRotateY += velocityY;

	bunny.style.transform =
		`rotateX(${currentRotateX}deg) rotateY(${currentRotateY}deg)`;

	requestAnimationFrame(animate);
}

animate();
