"""Fit w(z)^2 = a*z^2 + b*z + c, with z,w,wavelength in metres."""
import argparse,json
from pathlib import Path
import numpy as np

def fit(z,w,wavelength):
    z,w=np.asarray(z,float),np.asarray(w,float)
    if z.ndim!=1 or z.shape!=w.shape or len(z)<5 or not np.isfinite(z).all() or not np.isfinite(w).all() or np.any(w<=0) or not np.isfinite(wavelength) or wavelength<=0:
        raise ValueError('Need >=5 finite samples, positive radii and wavelength')
    if len(np.unique(z))<5: raise ValueError('Need >=5 distinct axial positions')
    origin=z.mean();scale=np.ptp(z);u=(z-origin)/scale
    a,b,c=np.polyfit(u,w*w,2)
    if a<=0:raise ValueError('Measured caustic has no positive divergence')
    w0sq=c-b*b/(4*a)
    if w0sq<=0:raise ValueError('Fit has nonphysical waist')
    waist=float(np.sqrt(w0sq));theta=float(np.sqrt(a)/scale)
    z0=float(origin-scale*b/(2*a))
    predicted=np.sqrt(w0sq+theta*theta*(z-z0)**2)
    return {'waist_radius_m':waist,'waist_position_m':z0,'divergence_rad':theta,'M2':float(np.pi*waist*theta/wavelength),'radius_rmse_m':float(np.sqrt(np.mean((w-predicted)**2)))},predicted

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--input',type=Path,help='CSV with z_m,w_m header');p.add_argument('--wavelength',type=float,default=1064e-9);p.add_argument('--output',type=Path,default=Path('artifacts'));args=p.parse_args()
    if args.input:
        data=np.loadtxt(args.input,delimiter=',',skiprows=1);z,w=data[:,0],data[:,1]
    else:
        z=np.linspace(-.5,.5,25);waist=.00025;theta=1.4*args.wavelength/(np.pi*waist);w=np.sqrt(waist**2+theta**2*(z-.03)**2)
    result,predicted=fit(z,w,args.wavelength);args.output.mkdir(parents=True,exist_ok=True)
    (args.output/'measurement.json').write_text(json.dumps(result,indent=2))
    np.savetxt(args.output/'samples.csv',np.column_stack([z,w]),delimiter=',',header='z_m,w_m',comments='')
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    fig,ax=plt.subplots(figsize=(10,5),layout='constrained');ax.scatter(z,w*1e3,label='Samples');order=np.argsort(z);ax.plot(z[order],predicted[order]*1e3,label=f"Fit M²={result['M2']:.3f}");ax.set(xlabel='z (m)',ylabel='Beam radius (mm)',title='Beam caustic fit'+(' — synthetic demo' if not args.input else ''));ax.legend();fig.savefig(args.output/'result.png',dpi=150);plt.close(fig);print(json.dumps(result,indent=2))
if __name__=='__main__':main()
