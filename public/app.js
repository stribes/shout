(() => {
	const MAX_LEN = 140;
	const MAX_SHOUTS = 500;
	const PALETTE = ['#e87552', '#528ccb', '#91b84a', '#e0ad3d', '#a77ad1', '#40a995', '#d45c7a'];

	const cloud = document.getElementById('cloud');
	const form = document.getElementById('shout-form');
	const textarea = document.getElementById('text');
	const counter = document.getElementById('counter');
	const statusEl = document.getElementById('status');
	const button = form.querySelector('button');
	const emptyState = document.getElementById('empty-state');

	let socket = null;
	let shouts = [];
	let freshId = null;
	let reconnectTimer = null;
	let reconnectDelay = 1000;
	let resizeTimer = null;

	function hash(value) {
		let result = 2166136261;

		for (let i = 0; i < value.length; i++) {
			result ^= value.charCodeAt(i);
			result = Math.imul(result, 16777619);
		}

		return result >>> 0;
	}

	function rng(seed) {
		let a = seed >>> 0;

		return () => {
			a += 0x6d2b79f5;

			let t = a;
			t = Math.imul(t ^ (t >>> 15), t | 1);
			t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
	}

	function intersects(a, b) {
		return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
	}

	function inflate(rect, padding) {
		return {
			left: rect.left - padding,
			top: rect.top - padding,
			right: rect.right + padding,
			bottom: rect.bottom + padding,
		};
	}

	function setStatus(message, isError = false) {
		statusEl.textContent = message;
		statusEl.classList.toggle('error', isError);
	}

	function setConnection(connected) {
		button.disabled = !connected;
	}

	function layout() {
		cloud.querySelectorAll('.tag').forEach((el) => el.remove());

		const width = window.innerWidth;
		const height = window.innerHeight;
		const mobile = width < 600;

		const formRect = form.getBoundingClientRect();

		const occupied = [
			inflate(
				{
					left: formRect.left,
					top: formRect.top,
					right: formRect.right,
					bottom: formRect.bottom,
				},
				14,
			),
		];

		const sorted = [...shouts].sort((a, b) => b.createdAt - a.createdAt);

		emptyState.classList.toggle('hidden', sorted.length > 0);

		sorted.forEach((shout, index) => {
			const random = rng(hash(shout.id));
			const freshness = 1 - index / Math.max(sorted.length, 1);

			const element = document.createElement('span');
			element.className = 'tag';
			element.textContent = shout.content;

			const colour = PALETTE[Math.floor(random() * PALETTE.length)];
			const rotation = (random() - 0.5) * 16;
			const opacity = 0.45 + 0.55 * freshness;

			element.style.color = colour;
			element.style.opacity = opacity;
			element.style.transform = `rotate(${rotation}deg)`;

			if (shout.content.length > 30) {
				element.style.whiteSpace = 'normal';
				element.style.width = `${Math.min(mobile ? 190 : 280, width * 0.55)}px`;
			}

			cloud.appendChild(element);

			let fontSize = (mobile ? 12 : 15) + (mobile ? 12 : 24) * freshness;

			let placed = false;

			for (let sizeAttempt = 0; sizeAttempt < 4 && !placed; sizeAttempt++, fontSize *= 0.8) {
				element.style.fontSize = `${fontSize}px`;

				const box = element.getBoundingClientRect();

				if (box.width > width - 12 || box.height > height - 12) {
					continue;
				}

				for (let attempt = 0; attempt < 80; attempt++) {
					const x = 6 + random() * Math.max(0, width - box.width - 12);
					const y = 6 + random() * Math.max(0, height - box.height - 12);

					const rect = {
						left: x,
						top: y,
						right: x + box.width,
						bottom: y + box.height,
					};

					const padded = inflate(rect, 5);

					if (occupied.every((other) => !intersects(padded, other))) {
						element.style.left = `${x}px`;
						element.style.top = `${y}px`;

						occupied.push(rect);
						placed = true;

						if (shout.id === freshId) {
							element.classList.add('fresh');
						}

						break;
					}
				}
			}

			if (!placed) {
				element.remove();
			}
		});

		freshId = null;
	}

	function addShout(shout) {
		if (!shout || typeof shout.id !== 'string') {
			return;
		}

		const existing = shouts.findIndex((item) => item.id === shout.id);

		if (existing !== -1) {
			shouts[existing] = shout;
		} else {
			shouts.push(shout);
		}

		shouts.sort((a, b) => a.createdAt - b.createdAt);

		if (shouts.length > MAX_SHOUTS) {
			shouts = shouts.slice(-MAX_SHOUTS);
		}

		freshId = shout.id;
		layout();
	}

	function handleMessage(event) {
		let data;

		try {
			data = JSON.parse(event.data);
		} catch {
			return;
		}

		switch (data.type) {
			case 'history':
				if (Array.isArray(data.shouts)) {
					shouts = data.shouts;
					layout();
				}
				break;

			case 'shout':
				addShout(data.shout);
				break;

			case 'error':
				setStatus(data.message || 'Something went wrong.', true);
				break;
		}
	}

	function connect() {
		clearTimeout(reconnectTimer);

		const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';

		socket = new WebSocket(`${protocol}//${window.location.host}/ws`);

		socket.addEventListener('open', () => {
			reconnectDelay = 1000;
			setConnection(true);
		});

		socket.addEventListener('message', handleMessage);

		socket.addEventListener('close', () => {
			setConnection(false);

			reconnectTimer = setTimeout(connect, reconnectDelay);
			reconnectDelay = Math.min(reconnectDelay * 2, 15000);
		});

		socket.addEventListener('error', () => {
			socket.close();
		});
	}

	textarea.addEventListener('input', () => {
		const length = [...textarea.value].length;
		counter.textContent = `${length} / ${MAX_LEN}`;
	});

	textarea.addEventListener('keydown', (event) => {
		if (event.key === 'Enter' && !event.shiftKey) {
			event.preventDefault();
			form.requestSubmit();
		}
	});

	form.addEventListener('submit', (event) => {
		event.preventDefault();

		const content = textarea.value.trim();

		if (!content || !socket || socket.readyState !== WebSocket.OPEN) {
			return;
		}

		if ([...content].length > MAX_LEN) {
			setStatus("That's a little too long.", true);
			return;
		}

		socket.send(
			JSON.stringify({
				type: 'shout',
				content,
			}),
		);

		textarea.value = '';
		counter.textContent = `0 / ${MAX_LEN}`;
		setStatus('Shouted into the world!');
		textarea.focus();
	});

	window.addEventListener('resize', () => {
		clearTimeout(resizeTimer);
		resizeTimer = setTimeout(layout, 150);
	});

	connect();
})();
