import { setFtpConnectorForTesting, type FtpConnector, type FtpSocket } from "../src/ftp";

/**
 * 测试用假 FTP socket: 按脚本回放响应, 记录写入的命令。
 * controlReadable 不主动 close——脚本耗尽后再有读取会挂起, 从而暴露脚本与实际会话不匹配。
 */
export class FakeFtpSocket implements FtpSocket {
	sent: string[] = [];
	closed = false;
	readonly opened: Promise<unknown>;
	readonly readable: ReadableStream<Uint8Array>;
	readonly writable: WritableStream<Uint8Array>;

	constructor(
		responses: string[] = [],
		options: { closeReadable?: boolean; rejectOpened?: boolean } = {},
	) {
		const encoder = new TextEncoder();
		const decoder = new TextDecoder();
		this.opened = options.rejectOpened ? Promise.reject(new Error("connect refused")) : Promise.resolve(null);
		this.readable = new ReadableStream<Uint8Array>({
			start: (controller) => {
				for (const line of responses) controller.enqueue(encoder.encode(line));
				if (options.closeReadable) controller.close();
			},
		});
		this.writable = new WritableStream<Uint8Array>({
			write: (chunk) => {
				this.sent.push(decoder.decode(chunk));
			},
		});
	}

	close(): void {
		this.closed = true;
	}
}

export interface InstalledFtpFakes {
	control: FakeFtpSocket;
	dataSockets: FakeFtpSocket[];
	calls: {
		control: { hostname: string; port: number } | null;
		data: { hostname: string; port: number }[];
	};
}

/**
 * 安装假的 FTP connector (替换真实 TCP 连接), 返回捕获对象。
 * 每个 dataScripts 元素对应一次数据连接的回放脚本; 测试结束须调用 setFtpConnectorForTesting(null) 恢复。
 */
export function installFtpFakes(
	controlScript: string[],
	dataScripts: string[][] = [],
	options: { rejectOpened?: boolean } = {},
): InstalledFtpFakes {
	const control = new FakeFtpSocket(controlScript, { closeReadable: false, rejectOpened: options.rejectOpened });
	const dataSockets = dataScripts.map((script) => new FakeFtpSocket(script, { closeReadable: true }));
	const fakes: InstalledFtpFakes = {
		control,
		dataSockets,
		calls: { control: null, data: [] },
	};
	let dataIndex = 0;
	const connector: FtpConnector = {
		connectControl: (hostname, port) => {
			fakes.calls.control = { hostname, port };
			return control;
		},
		connectData: (hostname, port) => {
			const socket = dataSockets[dataIndex++];
			fakes.calls.data.push({ hostname, port });
			if (!socket) throw new Error(`unexpected data connection #${dataIndex}: ${hostname}:${port}`);
			return socket;
		},
	};
	setFtpConnectorForTesting(connector);
	return fakes;
}
